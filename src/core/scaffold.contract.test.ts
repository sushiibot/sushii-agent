import { describe, expect, mock, test } from "bun:test";
import type {
  AuthorRef,
  Compactor,
  ConversationData,
  ConversationRef,
  ConversationStore,
  HookEvents,
  HookName,
  InboundMessage,
  MemoryEntry,
  MemoryProvider,
  SpaceMemoryStore,
  SurfaceSession,
  ToolRegistry,
} from "./contracts.ts";

// Capture the params handed to generateText so we can assert on the assembled system prompt.
let lastSystemPrompt = "";
mock.module("ai", () => {
  const actual = require("ai") as typeof import("ai");
  return {
    ...actual,
    generateText: async (params: { messages?: { role: string; content: unknown }[] }) => {
      // Capture ALL system messages joined — the proactive memory block is now a SEPARATE system
      // message after the cached system prompt (not inside it), so we must look past the first.
      const sysMsgs = (params.messages ?? []).filter((m) => m.role === "system");
      lastSystemPrompt = sysMsgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      return {
        text: "done",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        response: { messages: [{ role: "assistant", content: "done" }] },
      };
    },
  };
});

const { createAgentCore } = await import("./agentCore.ts");

const ref: ConversationRef = { surface: "discord", spaceId: "guild1", conversationId: "thread1" };
function author(userId: string): AuthorRef {
  return { surface: "discord", userId, username: `user-${userId}` };
}
function inbound(text: string): InboundMessage {
  return { conversation: ref, author: author("u1"), text };
}

class FakeStore implements ConversationStore {
  data: ConversationData = { messages: [], initialThreadContext: null };
  saves = 0;
  load(): ConversationData {
    return this.data;
  }
  save(_ref: ConversationRef, data: ConversationData): void {
    this.data = data;
    this.saves++;
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

function fakeSession(): SurfaceSession {
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
  };
}

const emptyTools: ToolRegistry = { resolve: () => [] };

function baseDeps(store: FakeStore) {
  return {
    model: { modelId: "test-model", contextLimit: 200_000 },
    store,
    memory: new FakeMemory(),
    tools: emptyTools,
    hooks: new FakeHooks(),
    behavior: "You are a test agent.",
  };
}

describe("scaffold contract — compaction + memory hook sites", () => {
  test("without compactor or memoryProvider, a turn completes and no memory block appears", async () => {
    const store = new FakeStore();
    const core = createAgentCore(baseDeps(store));
    const res = await core.handleInbound(inbound("hi"), fakeSession());
    expect(res.status).toBe("completed");
    expect(lastSystemPrompt).not.toContain("MEMORY-BLOCK");
  });

  test("a wired MemoryProvider's retrieved block lands in the assembled system prompt, scoped to the initiator", async () => {
    const store = new FakeStore();
    let seenScope: unknown;
    const memoryProvider: MemoryProvider = {
      retrieve: async ({ scope }) => {
        seenScope = scope;
        return "## Memory\nTEST-MEMORY-BLOCK";
      },
      remember: async () => {},
    };
    const core = createAgentCore({ ...baseDeps(store), memoryProvider });
    const res = await core.handleInbound(inbound("what do you know?"), fakeSession());
    expect(res.status).toBe("completed");
    expect(lastSystemPrompt).toContain("TEST-MEMORY-BLOCK");
    // guild1 is not a personal/DM space → public scope keyed to the triggering user u1.
    expect(seenScope).toEqual({ spaceId: "guild1", userId: "u1", isPrivate: false });
  });

  test("onTurnEnd carries the initiator authorId + isPrivate for the deriver's write scope", async () => {
    const store = new FakeStore();
    const hooks = new FakeHooks();
    let seen: { authorId?: string; isPrivate?: boolean } = {};
    hooks.on("onTurnEnd", (ctx) => {
      seen = { authorId: ctx.authorId, isPrivate: ctx.isPrivate };
    });
    const core = createAgentCore({ ...baseDeps(store), hooks });
    await core.handleInbound(inbound("hi"), fakeSession());
    expect(seen).toEqual({ authorId: "u1", isPrivate: false });
  });

  test("a MemoryProvider slower than the deadline injects nothing but the turn still completes", async () => {
    const store = new FakeStore();
    const memoryProvider: MemoryProvider = {
      retrieve: () => new Promise((resolve) => setTimeout(() => resolve("TEST-MEMORY-BLOCK"), 5_000)),
      remember: async () => {},
    };
    const core = createAgentCore({ ...baseDeps(store), memoryProvider });
    const res = await core.handleInbound(inbound("slow memory"), fakeSession());
    expect(res.status).toBe("completed");
    expect(lastSystemPrompt).not.toContain("TEST-MEMORY-BLOCK");
  });

  test("a throwing MemoryProvider never breaks the turn", async () => {
    const store = new FakeStore();
    const memoryProvider: MemoryProvider = {
      retrieve: async () => {
        throw new Error("provider down");
      },
      remember: async () => {},
    };
    const core = createAgentCore({ ...baseDeps(store), memoryProvider });
    const res = await core.handleInbound(inbound("boom"), fakeSession());
    expect(res.status).toBe("completed");
  });

  test("a Compactor that folds rewrites the run history and persists it", async () => {
    const store = new FakeStore();
    store.data = {
      messages: [
        { role: "user", content: "old-1" },
        { role: "assistant", content: "old-2" },
      ],
      initialThreadContext: null,
    };
    let sawMessages = 0;
    const compactor: Compactor = {
      maybeCompact: async ({ messages }) => {
        sawMessages = messages.length;
        return {
          messages: [{ role: "system", content: "SUMMARY: prior conversation folded" }],
          compacted: true,
          factCandidates: ["a durable fact"],
        };
      },
    };
    const core = createAgentCore({ ...baseDeps(store), compactor });
    const res = await core.handleInbound(inbound("continue"), fakeSession());
    expect(res.status).toBe("completed");
    expect(sawMessages).toBe(2); // saw the persisted history before the new turn was appended
    // The folded summary is persisted and used as the run's prefix.
    expect(JSON.stringify(store.data.messages)).toContain("SUMMARY: prior conversation folded");
  });

  test("a Compactor returning compacted:false leaves history untouched", async () => {
    const store = new FakeStore();
    store.data = { messages: [{ role: "user", content: "keep-me" }], initialThreadContext: null };
    const compactor: Compactor = {
      maybeCompact: async ({ messages }) => ({ messages, compacted: false, factCandidates: [] }),
    };
    const core = createAgentCore({ ...baseDeps(store), compactor });
    const res = await core.handleInbound(inbound("hi"), fakeSession());
    expect(res.status).toBe("completed");
    expect(JSON.stringify(store.data.messages)).toContain("keep-me");
  });
});
