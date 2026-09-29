import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";
import { commitHome, scaffoldHome } from "./home.ts";
import { FLUSH_MARKER, memoryFilesSignature } from "./memoryFlush.ts";
import { PersonalSession, type ChatTransport } from "./personalSession.ts";
import { compactionTrigger, createPiChatSessionFactory, reloadContext } from "./piChatSession.ts";
import { runnerGit } from "../orchestration/runner/runnerGit.ts";
import type { ChatDeliverParams } from "../orchestration/contracts.ts";

// Real Pi 0.99.1 sessions from the workspace factory, a real git home; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";
const DEFAULT_WINDOW = 800_000;
const MAX_TOKENS = 65_536;

let root: string;
let bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
let replies: Array<() => Response>;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

type Reply = { text?: string; tool?: { name: string; args: object }; promptTokens?: number };

function sse(reply: Reply): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-6-luna", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
    : { role: "assistant", content: reply.text ?? "" };
  const body =
    chunk(delta, null) +
    chunk({}, reply.tool ? "tool_calls" : "stop", { usage: { prompt_tokens: reply.promptTokens ?? 10, completion_tokens: 3, total_tokens: (reply.promptTokens ?? 10) + 3 } }) +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function script(...rs: Reply[]): void {
  replies.push(...rs.map((r) => () => sse(r)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-memory-pi-"));
  bodies = [];
  replies = [];
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (!url.startsWith(`${OPENROUTER_BASE}/chat/completions`)) throw new Error(`unexpected fetch in test: ${url}`);
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

function config(): WorkspaceConfig {
  return {
    provider: "openrouter",
    chatgptModel: "gpt-6.1-sol",
    model: "openai/gpt-6-luna",
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
}

const lastUserText = (i: number) => JSON.stringify(bodies[i].messages.filter((m) => m.role === "user").at(-1)?.content);

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function host() {
  const cfg = config();
  await scaffoldHome(cfg.home);
  const delivered: ChatDeliverParams[] = [];
  const transport: ChatTransport = {
    request: async (method, params) => {
      if (method === "chat/deliver") delivered.push(params as ChatDeliverParams);
      return {};
    },
    notify: () => {},
  };
  const personal = new PersonalSession({
    principalId: "drk",
    model: cfg.model,
    stateDir: cfg.stateDir,
    factory: createPiChatSessionFactory(cfg),
    transport,
    textDeltaMs: null,
    memory: {
      compactionTrigger,
      reload: reloadContext,
      commit: (m) => commitHome(m, { home: cfg.home }),
      signature: () => memoryFilesSignature(cfg.home),
    },
  });
  await personal.start();
  const log = async () => (await runnerGit(cfg.home).raw(["log", "--format=%s"])).trim().split("\n");
  return { personal, delivered, home: cfg.home, log };
}

const user = (messageId: string, text: string) => ({
  principalId: "drk",
  origin: { surface: "discord", conversationId: "dm" },
  messageId,
  text,
  kind: "user" as const,
  author: { id: "1", name: "drk" },
});

describe("memory upkeep on a real Pi session", () => {
  test("the compaction trigger is the model window minus the reserve override", async () => {
    const { session } = await createPiChatSessionFactory(config())({ sessionFile: null });
    expect(compactionTrigger(session)).toBe(DEFAULT_WINDOW - MAX_TOKENS);
    session.dispose();
  });

  test("chat/new flushes through Pi's tools, delivers nothing for it, commits, and starts a new session", async () => {
    const { personal, delivered, home, log } = await host();
    script({ text: "noted" });
    await personal.handleMessage(user("m1", "I like tea"));
    await until(() => delivered.length === 1);

    script({ tool: { name: "edit", args: { path: "USER.md", edits: [{ oldText: "# USER.md", newText: "# USER.md\n- Likes tea. (src: 2026-09-29)" }] } } }, { text: "Saved to USER.md." });
    const before = personal.currentSessionFile;
    await personal.handleNew();

    expect(lastUserText(1)).toContain(FLUSH_MARKER);
    expect(readFileSync(join(home, "USER.md"), "utf8")).toContain("- Likes tea.");
    expect(delivered.map((d) => d.text)).toEqual(["noted"]);
    expect((await log())[0]).toBe("memory: flush before new session");
    expect(personal.currentSessionFile).not.toBe(before);
    await personal.dispose();
  }, 20_000);

  test("near the trigger a turn is followed by a hidden flush, a commit and a context reload", async () => {
    const { personal, delivered, home, log } = await host();
    expect(readFileSync(join(home, "USER.md"), "utf8")).not.toContain("Likes tea");
    // The reply's usage puts the context inside the flush band, below Pi's own trigger.
    script({ text: "big answer", promptTokens: 700_000 });
    script({ tool: { name: "edit", args: { path: "USER.md", edits: [{ oldText: "# USER.md", newText: "# USER.md\n- Likes tea. (src: 2026-09-29)" }] } } }, { text: "NO_REPLY" });
    await personal.handleMessage(user("m1", "long question"));
    await until(() => bodies.length === 3);
    await until(() => (personal as unknown as { session: AgentSession }).session.systemPrompt.includes("Likes tea"));

    expect(lastUserText(1)).toContain(FLUSH_MARKER);
    expect(delivered.map((d) => d.text)).toEqual(["big answer"]);
    expect(await log()).toContain("memory: flush before compaction");
    await personal.dispose();
  }, 20_000);

  test("the memory guard blocks a secret write made by a real tool call", async () => {
    const { personal, delivered, home } = await host();
    script({ tool: { name: "write", args: { path: "MEMORY.md", content: "- key sk-abcdefghijklmnopqrstuv\n" } } }, { text: "couldn't save that" });
    await personal.handleMessage(user("m1", "remember my key"));
    await until(() => delivered.length === 1);
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).not.toContain("sk-");
    expect(JSON.stringify(bodies[1].messages.at(-1))).toContain("memory guard");
    await personal.dispose();
  }, 20_000);

  test("a compaction with no flush this cycle leaves a handoff in today's daily note", async () => {
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    const cfg = config();
    await scaffoldHome(cfg.home);
    const { session } = await createPiChatSessionFactory(cfg)({ sessionFile: null });
    script({ text: "Sure, the plan is drafted. Open: book the hotel." }, { text: "and more" }, { text: "## Summary\ncompacted" }, { text: "## Prefix\ncompacted" });
    await (session as AgentSession).prompt("[discord:1 2026-09-29 13:00 UTC]\nplan the Osaka trip");
    await (session as AgentSession).prompt("[discord:2 2026-09-29 13:01 UTC]\nanything else?");
    await (session as AgentSession).compact();
    const daily = readFileSync(join(cfg.home, "memory", `${new Date().toISOString().slice(0, 10)}.md`), "utf8");
    expect(daily).toContain("Compaction handoff");
    expect(daily).toContain("plan the Osaka trip");
    session.dispose();
  }, 20_000);
});
