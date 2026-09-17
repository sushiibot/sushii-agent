import { describe, expect, mock, test, beforeEach } from "bun:test";
import type {
  AgentReply,
  AuthorRef,
  ConversationData,
  ConversationRef,
  ConversationStore,
  HookBus,
  HookEvents,
  HookName,
  InboundMessage,
  Interceptors,
  MemoryEntry,
  PendingInteraction,
  SpaceMemoryStore,
  SurfaceSession,
  ToolEntry,
  ToolHosts,
  ToolRegistry,
} from "./contracts.ts";

// mock.module must replace "ai" before agentCore.ts's own `import { generateText } from "ai"`
// binding resolves.
type GenerateTextParams = { toolCalls?: unknown[] };
let respond: (call: number, params: GenerateTextParams) => Promise<unknown> = async () => ({
  text: "done",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  response: { messages: [{ role: "assistant", content: "done" }] },
});
let callCount = 0;

mock.module("ai", () => {
  const actual = require("ai") as typeof import("ai");
  return {
    ...actual,
    generateText: async (params: GenerateTextParams) => {
      callCount++;
      return respond(callCount, params);
    },
  };
});

const { createAgentCore } = await import("./agentCore.ts");

beforeEach(() => {
  callCount = 0;
  respond = async () => ({
    text: "done",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
    response: { messages: [{ role: "assistant", content: "done" }] },
  });
});

function author(userId: string): AuthorRef {
  return { surface: "discord", userId, username: `user-${userId}` };
}

const ref: ConversationRef = { surface: "discord", spaceId: "guild1", conversationId: "thread1" };

function inbound(userId: string, text = "hi"): InboundMessage {
  return { conversation: ref, author: author(userId), text };
}

class FakeStore implements ConversationStore {
  data: ConversationData = { messages: [], initialThreadContext: null };
  load(): ConversationData {
    return this.data;
  }
  save(_ref: ConversationRef, data: ConversationData): void {
    this.data = data;
  }
  deleteStale(): void {}
}

class FakeMemory implements SpaceMemoryStore {
  getServerContext(): string | null {
    return null;
  }
  setServerContext(): void {}
  listTitles(): string[] {
    return [];
  }
  count(): number {
    return 0;
  }
  read(): MemoryEntry | null {
    return null;
  }
  search(): MemoryEntry[] {
    return [];
  }
  upsert(): { ok: true } | { error: string } {
    return { ok: true };
  }
  delete(): boolean {
    return false;
  }
}

/** Minimal HookBus implementing both `.on` and `.emit` (contracts.ts §6). */
class FakeHooks {
  handlers = new Map<HookName, ((ctx: unknown) => void)[]>();
  on<E extends HookName>(event: E, handler: HookEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (ctx: unknown) => void);
    this.handlers.set(event, list);
  }
  emit<E extends HookName>(event: E, ctx: Parameters<HookEvents[E]>[0]): void {
    for (const h of this.handlers.get(event) ?? []) h(ctx);
  }
}

function fakeSession(overrides: Partial<SurfaceSession> = {}): SurfaceSession {
  return {
    capabilities: {
      richComponents: false,
      customEmoji: false,
      nativeTimestamps: false,
      threads: true,
      reactions: false,
      progress: false,
      interactiveChoices: true,
      typing: false,
      replyTo: false,
    },
    renderer: {
      renderText: (t) => t,
      promptGuidance: () => ({ sections: {} }),
      describeUser: (a) => a.username ?? a.userId,
    },
    selfId: "bot1",
    selfName: "bot",
    deliver: async () => ({}),
    hosts: {},
    ...overrides,
  };
}

function emptyTools(): ToolRegistry {
  return { resolve: () => [] };
}

function coreDeps(overrides: { tools?: ToolRegistry; interceptors?: Interceptors; hooks?: HookBus } = {}) {
  const store = new FakeStore();
  const memory = new FakeMemory();
  const hooks = overrides.hooks ?? new FakeHooks();
  return {
    deps: {
      model: { modelId: "test-model", contextLimit: 200_000 },
      store,
      memory,
      tools: overrides.tools ?? emptyTools(),
      interceptors: overrides.interceptors,
      hooks,
      behavior: "You are a test agent.",
    },
    store,
    hooks,
  };
}

describe("createAgentCore — queue-or-run arbitration", () => {
  test("a second inbound during an active turn is queued, and onQueued fires", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    respond = async (call) => {
      if (call === 1) await held;
      return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "done" }] } };
    };

    const { deps, hooks } = coreDeps();
    const core = createAgentCore(deps);
    const queuedEvents: InboundMessage[] = [];
    hooks.on("onQueued", (ctx) => queuedEvents.push(ctx.inbound));

    const first = core.handleInbound(inbound("u1", "first"), fakeSession());
    // Give the first turn's generateText call a chance to start (and block on `held`).
    await Promise.resolve();
    await Promise.resolve();

    const second = await core.handleInbound(inbound("u2", "second"), fakeSession());
    expect(second).toEqual({ status: "queued" });
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0].text).toBe("second");

    release();
    const firstResult = await first;
    expect(firstResult.status).toBe("completed");
  });
});

describe("createAgentCore — pause and resume", () => {
  function askQuestionTools(): ToolRegistry {
    const entry: ToolEntry<never> = {
      name: "ask_question",
      definition: { name: "ask_question", description: "ask", parameters: {} },
      requiresHosts: [],
      requiresCapabilities: ["interactiveChoices"],
      execute: async (input, ctx) => {
        ctx.pending?.push({
          kind: "question",
          payload: { question: input.question as string, choices: input.choices as string[], authorizedResponder: author("u1") },
        });
        return { content: "Question sent to moderator. Awaiting their response via button click." };
      },
    };
    return { resolve: () => [entry as ToolEntry<keyof ToolHosts>] };
  }

  test("ask_question pauses the turn, then resume re-enters with the answer", async () => {
    let presented: PendingInteraction | undefined;
    respond = async (call) => {
      if (call === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "1", toolName: "ask_question", input: { question: "Pick one", choices: ["a", "b"] } }],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          response: { messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "ask_question", input: {} }] }] },
        };
      }
      return { text: "resumed", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "resumed" }] } };
    };

    const { deps, store } = coreDeps({ tools: askQuestionTools() });
    const core = createAgentCore(deps);
    const session = fakeSession({ presentInteraction: async (p) => { presented = p; } });

    const paused = await core.handleInbound(inbound("u1", "ask me"), session);
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") throw new Error("expected paused");
    expect(paused.pending.kind).toBe("question");
    expect(presented).toEqual(paused.pending);
    expect(store.data.messages.length).toBeGreaterThan(0);

    const resumed = await core.resume(ref, { kind: "question-answer", choice: "a", by: author("u1") }, session);
    expect(resumed).toEqual({
      status: "completed",
      reply: expect.objectContaining({ segments: [{ kind: "text", text: "resumed" }] }),
    });
  });
});

describe("createAgentCore — cancel owner-gate", () => {
  test("only the turn's initiating author may cancel it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    respond = async (call) => {
      if (call === 1) await held;
      return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "done" }] } };
    };

    const { deps, hooks } = coreDeps();
    const core = createAgentCore(deps);
    let cancelledFired = false;
    hooks.on("onCancelled", () => { cancelledFired = true; });

    const turn = core.handleInbound(inbound("u1", "long task"), fakeSession());
    await Promise.resolve();
    await Promise.resolve();

    expect(core.cancel(ref, author("u2"))).toEqual({ status: "forbidden", owner: author("u1") });
    expect(core.cancel(ref, author("u1"))).toEqual({ status: "cancelling" });

    release();
    const result = await turn;
    expect(result).toEqual({ status: "cancelled" });
    expect(cancelledFired).toBe(true);
  });

  test("cancelling a conversation with no active turn reports no-active-turn", () => {
    const { deps } = coreDeps();
    const core = createAgentCore(deps);
    expect(core.cancel(ref, author("u1"))).toEqual({ status: "no-active-turn" });
  });
});

describe("createAgentCore — interceptTool veto", () => {
  test("a blocked tool never executes, and the model sees the block reason", async () => {
    let executed = false;
    const entry: ToolEntry<never> = {
      name: "delete_everything",
      definition: { name: "delete_everything", description: "danger", parameters: {} },
      requiresHosts: [],
      execute: async () => {
        executed = true;
        return { content: "deleted" };
      },
    };
    const tools: ToolRegistry = { resolve: () => [entry as ToolEntry<keyof ToolHosts>] };
    const interceptors: Interceptors = {
      interceptTool: (call) => (call.tool === "delete_everything" ? { block: true, reason: "vetoed" } : { block: false }),
    };

    let seenBlockReason: string | undefined;
    respond = async (call) => {
      if (call === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "1", toolName: "delete_everything", input: {} }],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          response: { messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "delete_everything", input: {} }] }] },
        };
      }
      return { text: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "ok" }] } };
    };

    const { deps, store } = coreDeps({ tools, interceptors });
    const core = createAgentCore(deps);
    const result = await core.handleInbound(inbound("u1", "delete it all"), fakeSession());

    expect(executed).toBe(false);
    expect(result.status).toBe("completed");
    const toolMsg = store.data.messages.find((m) => m.role === "tool");
    const part = (toolMsg?.content as { output: { value: string } }[] | undefined)?.[0];
    seenBlockReason = part?.output.value;
    expect(seenBlockReason).toBe("vetoed");
  });
});

describe("createAgentCore — enforceCalledAlone", () => {
  function askQuestionPlusOtherTools(): ToolRegistry {
    const askQuestion: ToolEntry<never> = {
      name: "ask_question",
      definition: { name: "ask_question", description: "ask", parameters: {} },
      requiresHosts: [],
      requiresCapabilities: ["interactiveChoices"],
      execute: async (input, ctx) => {
        ctx.pending?.push({
          kind: "question",
          payload: { question: input.question as string, choices: input.choices as string[], authorizedResponder: author("u1") },
        });
        return { content: "Question sent to moderator. Awaiting their response via button click." };
      },
    };
    const other: ToolEntry<never> = {
      name: "other_tool",
      definition: { name: "other_tool", description: "does something", parameters: {} },
      requiresHosts: [],
      execute: async () => ({ content: "other tool ran" }),
    };
    return { resolve: () => [askQuestion, other] as ToolEntry<keyof ToolHosts>[] };
  }

  test("ask_question called alongside another tool in the same batch is overridden with a retry error, and the turn does not pause", async () => {
    respond = async (call) => {
      if (call === 1) {
        return {
          text: "",
          toolCalls: [
            { toolCallId: "1", toolName: "ask_question", input: { question: "Pick one", choices: ["a", "b"] } },
            { toolCallId: "2", toolName: "other_tool", input: {} },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          response: {
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "1", toolName: "ask_question", input: {} },
                  { type: "tool-call", toolCallId: "2", toolName: "other_tool", input: {} },
                ],
              },
            ],
          },
        };
      }
      return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "done" }] } };
    };

    const { deps, store } = coreDeps({ tools: askQuestionPlusOtherTools() });
    const core = createAgentCore(deps);
    const result = await core.handleInbound(inbound("u1", "ask and act"), fakeSession());

    expect(result.status).toBe("completed");
    const toolMsg = store.data.messages.find((m) => m.role === "tool");
    const parts = toolMsg?.content as { toolCallId: string; output: { value: string } }[];
    const askResult = parts.find((p) => p.toolCallId === "1");
    const otherResult = parts.find((p) => p.toolCallId === "2");
    expect(askResult?.output.value).toBe(
      "ask_question must be called alone — do not combine it with other tool calls in the same turn. Try again with only ask_question.",
    );
    expect(otherResult?.output.value).toBe("other tool ran");
  });
});

describe("createAgentCore — timeout-first ordering", () => {
  test("timeout_member runs before other tools in the same batch, regardless of call order", async () => {
    const executionOrder: string[] = [];
    const timeoutTool: ToolEntry<never> = {
      name: "timeout_member",
      definition: { name: "timeout_member", description: "timeout", parameters: {} },
      requiresHosts: [],
      execute: async () => {
        executionOrder.push("timeout_member");
        return { content: "timed out" };
      },
    };
    const otherTool: ToolEntry<never> = {
      name: "delete_user_messages",
      definition: { name: "delete_user_messages", description: "delete", parameters: {} },
      requiresHosts: [],
      execute: async () => {
        executionOrder.push("delete_user_messages");
        return { content: "deleted" };
      },
    };
    const tools: ToolRegistry = { resolve: () => [timeoutTool, otherTool] as ToolEntry<keyof ToolHosts>[] };

    respond = async (call) => {
      if (call === 1) {
        return {
          text: "",
          // delete_user_messages listed first in the batch — ordering must still put timeout first.
          toolCalls: [
            { toolCallId: "1", toolName: "delete_user_messages", input: {} },
            { toolCallId: "2", toolName: "timeout_member", input: {} },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          response: {
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "1", toolName: "delete_user_messages", input: {} },
                  { type: "tool-call", toolCallId: "2", toolName: "timeout_member", input: {} },
                ],
              },
            ],
          },
        };
      }
      return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "done" }] } };
    };

    const { deps } = coreDeps({ tools });
    const core = createAgentCore(deps);
    const result = await core.handleInbound(inbound("u1", "spam then timeout"), fakeSession());

    expect(result.status).toBe("completed");
    expect(executionOrder).toEqual(["timeout_member", "delete_user_messages"]);
  });
});

describe("createAgentCore — images/knownUsers sink draining", () => {
  function inspectImageTool(urls: string[]): ToolRegistry {
    const entry: ToolEntry<never> = {
      name: "inspect_image",
      definition: { name: "inspect_image", description: "inspect", parameters: {} },
      requiresHosts: [],
      execute: async (_input, ctx) => {
        ctx.images?.push(urls);
        return { content: `${urls.length} image(s) attached below` };
      },
    };
    return { resolve: () => [entry as ToolEntry<keyof ToolHosts>] };
  }

  test("images pushed to ctx.images are injected as an ephemeral user message, not persisted", async () => {
    let secondCallMessages: unknown[] = [];
    respond = async (call, params) => {
      if (call === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "1", toolName: "inspect_image", input: {} }],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          response: { messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "inspect_image", input: {} }] }] },
        };
      }
      secondCallMessages = (params as { messages: unknown[] }).messages;
      return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "done" }] } };
    };

    const { deps, store } = coreDeps({ tools: inspectImageTool(["https://cdn.discordapp.com/a.png", "https://cdn.discordapp.com/b.png"]) });
    const core = createAgentCore(deps);
    const result = await core.handleInbound(inbound("u1", "look at this"), fakeSession());

    expect(result.status).toBe("completed");
    const imageMsg = secondCallMessages.find(
      (m): m is { role: string; content: { type: string }[] } =>
        typeof m === "object" && m !== null && "content" in m && Array.isArray((m as { content: unknown }).content) && (m as { content: { type: string }[] }).content[0]?.type === "image",
    );
    expect(imageMsg).toBeDefined();
    expect(imageMsg?.content).toHaveLength(2);
    // Ephemeral — the signed CDN URLs are dead by the next turn, so this must not be persisted.
    const persistedHasImage = store.data.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p: { type?: string }) => p.type === "image"),
    );
    expect(persistedHasImage).toBe(false);
  });

  function knownUsersTool(): ToolRegistry {
    const entry: ToolEntry<never> = {
      name: "discover_user",
      definition: { name: "discover_user", description: "discovers a user", parameters: {} },
      requiresHosts: [],
      execute: async (_input, ctx) => {
        ctx.knownUsers?.add("u9", { username: "someone", displayName: null });
        return { content: "found u9" };
      },
    };
    return { resolve: () => [entry as ToolEntry<keyof ToolHosts>] };
  }

  test("a user discovered across two batches is only noted once (de-duped against knownUsers)", async () => {
    respond = async (call) => {
      if (call === 1 || call === 2) {
        return {
          text: "",
          toolCalls: [{ toolCallId: String(call), toolName: "discover_user", input: {} }],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
          response: { messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: String(call), toolName: "discover_user", input: {} }] }] },
        };
      }
      return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [{ role: "assistant", content: "done" }] } };
    };

    const { deps, store } = coreDeps({ tools: knownUsersTool() });
    const core = createAgentCore(deps);
    const result = await core.handleInbound(inbound("u1", "find u9 twice"), fakeSession());

    expect(result.status).toBe("completed");
    const userNotes = store.data.messages.filter(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("[Internal: user identity mappings"),
    );
    expect(userNotes).toHaveLength(1);
    expect(userNotes[0].content).toContain("u9");
  });
});

describe("createHookBus — failure isolation", () => {
  test("a throwing handler does not break the turn, and later handlers for the same event still run", async () => {
    const { createHookBus } = await import("./hooks.ts");
    const hooks = createHookBus();
    let laterHandlerRan = false;
    hooks.on("onTurnStart", () => {
      throw new Error("boom");
    });
    hooks.on("onTurnStart", () => {
      laterHandlerRan = true;
    });

    const { deps } = coreDeps({ hooks });
    const core = createAgentCore(deps);
    const result = await core.handleInbound(inbound("u1", "hi"), fakeSession());

    expect(result.status).toBe("completed");
    expect(laterHandlerRan).toBe(true);
  });
});
