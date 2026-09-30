import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CompactionEntry } from "@earendil-works/pi-coding-agent";
import { BackendSelector } from "./chatgptFallback.ts";
import { DEFAULT_ECONOMY, parseModelList, type EconomyConfig, type WorkspaceConfig } from "./config.ts";
import { CLEARED_PREFIX } from "./contextEconomy.ts";
import { scaffoldHome } from "./home.ts";
import { ModelChoice } from "./modelChoice.ts";
import type { ChatSession } from "./personalSession.ts";
import { compactionTrigger, createPiChatSessionFactory, idleRotateMs, recapSession } from "./piChatSession.ts";

// Real Pi 0.99.1 sessions from the workspace factory; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";
const SUMMARY_MARK = "[context summary request";

type Backend = "chatgpt" | "openrouter";
type Reply = { text?: string; tool?: { name: string; args: object }; inputTokens?: number };
interface Req {
  backend: Backend;
  body: Record<string, unknown>;
  headers: Headers;
}

let root: string;
let reqs: Req[];
let script: Reply[];
let chatgptDown: boolean;
let n: number;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

function responsesSse(reply: Reply): Response {
  const ev = (o: object) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
  const id = ++n;
  let out = ev({ type: "response.created", response: { id: `resp_${id}`, status: "in_progress" } });
  if (reply.tool) {
    const item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: reply.tool.name, arguments: JSON.stringify(reply.tool.args), status: "completed" };
    out += ev({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    out += ev({ type: "response.output_item.done", output_index: 0, item });
  } else {
    const text = reply.text ?? "";
    const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    out += ev({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    out += ev({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text });
    out += ev({ type: "response.output_item.done", output_index: 0, item });
  }
  const input = reply.inputTokens ?? 10;
  out += ev({ type: "response.completed", response: { id: `resp_${id}`, status: "completed", usage: { input_tokens: input, output_tokens: 3, total_tokens: input + 3 } } });
  return new Response(out, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function completionsSse(reply: Reply): Response {
  const id = ++n;
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: `gen-${id}`, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
    : { role: "assistant", content: reply.text ?? "" };
  const input = reply.inputTokens ?? 10;
  const body = chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop", { usage: { prompt_tokens: input, completion_tokens: 3, total_tokens: input + 3 } }) + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-economy-pi-"));
  reqs = [];
  script = [];
  chatgptDown = false;
  n = 0;
  delete process.env.OPENAI_API_KEY;
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "test-access-token", refresh: "test-refresh-token", expires: Date.now() + 24 * 3_600_000, clientId: "test-client", scopes: ["chatgpt.tokens.use.direct"] },
    }),
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    const backend: Backend | null = url.startsWith("https://api.openai.com/") ? "chatgpt" : url.startsWith(`${OPENROUTER_BASE}/chat/completions`) ? "openrouter" : null;
    if (!backend) throw new Error(`unexpected fetch in test: ${url}`);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}");
    reqs.push({ backend, body: JSON.parse(String(raw)) as Record<string, unknown>, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    if (backend === "chatgpt" && chatgptDown) {
      return new Response(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", type: "usage_limit_reached", message: "usage limit reached" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    const reply = script.shift() ?? { text: "ok" };
    return backend === "chatgpt" ? responsesSse(reply) : completionsSse(reply);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

function config(provider: Backend, economy: Partial<EconomyConfig> = {}): WorkspaceConfig {
  return {
    provider,
    chatgptModel: "gpt-6.1-sol",
    model: "openai/gpt-6-luna",
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
    principalId: "drk",
    economy: { ...DEFAULT_ECONOMY, ...economy },
  } as WorkspaceConfig;
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function open(cfg: WorkspaceConfig, opts: { choice?: ModelChoice; selector?: BackendSelector } = {}) {
  await scaffoldHome(cfg.home);
  const { session } = await createPiChatSessionFactory(cfg, { selector: opts.selector ?? new BackendSelector({ primaryEnabled: cfg.provider === "chatgpt" }), ...(opts.choice ? { choice: opts.choice } : {}) })({
    sessionFile: null,
  });
  return session as AgentSession & ChatSession;
}

const isSummary = (r: Req) => JSON.stringify(r.body).includes(SUMMARY_MARK);
const compactions = (s: AgentSession) => s.sessionManager.getBranch().filter((e): e is CompactionEntry => e.type === "compaction");
const lastUserText = (r: Req): string => {
  const items = (r.body.input ?? r.body.messages) as Array<{ role?: string; content?: unknown }>;
  return JSON.stringify(items.filter((m) => m.role === "user").at(-1)?.content);
};

describe("anchored compaction on a real Pi session", () => {
  test("the threshold compaction uses our summary, sent as a cached continuation of the main request", async () => {
    const session = await open(config("chatgpt", { compactTokens: 2000, keepRecentTokens: 1 }));
    expect(compactionTrigger(session)).toBe(2000);
    script.push({ text: "Drafted the Osaka plan.", inputTokens: 5000 }, { text: "## Goals\n- Osaka trip (first summary)" });
    await session.prompt("[discord:1 2026-09-29 13:00 UTC]\nplan the Osaka trip");
    await until(() => compactions(session).length === 1);

    const main = reqs[0]!;
    const summary = reqs[1]!;
    expect(isSummary(main)).toBe(false);
    expect(isSummary(summary)).toBe(true);
    const mainInput = main.body.input as unknown[];
    expect((summary.body.input as unknown[]).slice(0, mainInput.length)).toEqual(mainInput);
    expect(summary.body.prompt_cache_key).toBeDefined();
    expect(summary.body.prompt_cache_key).toBe(main.body.prompt_cache_key);
    expect(String(summary.body.prompt_cache_key)).toBe(session.sessionId.slice(0, String(summary.body.prompt_cache_key).length));
    expect(summary.body.tools).toEqual(main.body.tools);
    expect(summary.body.model).toBe(main.body.model);
    expect(summary.body.reasoning).toEqual(main.body.reasoning);

    const first = compactions(session)[0]!;
    expect(first.summary).toBe("## Goals\n- Osaka trip (first summary)");
    expect(first.details).toEqual({ anchored: true });
    expect(first.fromHook).toBe(true);

    // The next compaction merges into the previous anchored summary rather than starting over.
    script.push({ text: "Booked the hotel.", inputTokens: 6000 }, { text: "## Goals\n- Osaka trip (merged)" });
    await session.prompt("[discord:2 2026-09-29 13:05 UTC]\nbook the hotel");
    await until(() => compactions(session).length === 2);
    const second = reqs.filter(isSummary)[1]!;
    expect(lastUserText(second)).toContain("<previous-summary>\\n## Goals\\n- Osaka trip (first summary)\\n</previous-summary>");
    expect(compactions(session)[1]!.summary).toBe("## Goals\n- Osaka trip (merged)");
    session.dispose();
  }, 20_000);

  test("a summary reply that is a tool call falls back to Pi's own summarizer", async () => {
    const session = await open(config("chatgpt", { compactTokens: 2000, keepRecentTokens: 1 }));
    script.push({ text: "ok", inputTokens: 5000 }, { tool: { name: "read", args: { path: "USER.md" } } }, { text: "## Goal\nPi's own" }, { text: "## Prefix\nPi's own" });
    await session.prompt("[discord:1 2026-09-29 13:00 UTC]\nhello");
    await until(() => compactions(session).length === 1);
    expect(compactions(session)[0]!.details).not.toEqual({ anchored: true });
    session.dispose();
  }, 20_000);

  test("the recap is a cached continuation on OpenRouter too: same messages prefix and session affinity", async () => {
    const session = await open(config("openrouter"));
    script.push({ text: "Sure." }, { text: "## Goals\n- recap body" });
    await session.prompt("[discord:1 2026-09-29 13:00 UTC]\nremember the dentist on Friday");
    const recap = await recapSession(session);
    expect(recap?.text).toBe("## Goals\n- recap body");
    const [main, rec] = reqs as [Req, Req];
    expect(isSummary(rec)).toBe(true);
    const mainMessages = main.body.messages as unknown[];
    expect((rec.body.messages as unknown[]).slice(0, mainMessages.length)).toEqual(mainMessages);
    expect(rec.body.tools).toEqual(main.body.tools);
    // "x-session-id" on openrouter.ai; the test base URL gets pi-ai's generic affinity header.
    const affinity = (r: Req) => r.headers.get("x-session-id") ?? r.headers.get("x-session-affinity");
    expect(affinity(rec)).toBe(session.sessionId);
    expect(affinity(rec)).toBe(affinity(main));
    expect(lastUserText(rec)).toContain("session is about to end");
    session.dispose();
  }, 20_000);

  test("the idle-rotation window is shorter on OpenRouter", async () => {
    const onChatGpt = await open(config("chatgpt"));
    expect(idleRotateMs(onChatGpt, config("chatgpt"))).toBe(25 * 60_000);
    onChatGpt.dispose();
    const onOpenRouter = await open(config("openrouter"));
    expect(idleRotateMs(onOpenRouter, config("openrouter"))).toBe(8 * 60_000);
    onOpenRouter.dispose();
  }, 20_000);
});

describe("tool-output hygiene on a real Pi session", () => {
  test("past the threshold, old tool results become stubs in one batch at a turn boundary; recent ones stay", async () => {
    const cfg = config("openrouter", { hygieneTokens: 100 });
    const session = await open(cfg);
    for (let i = 1; i <= 12; i++) writeFileSync(join(cfg.home, `note${i}.md`), `note ${i}\n${"lorem ipsum ".repeat(100)}`);
    let file = 0;
    const turn = async (k: number) => {
      for (let j = 0; j < 3; j++) script.push({ tool: { name: "read", args: { path: `note${++file}.md` } }, inputTokens: 500 });
      script.push({ text: `turn ${k} done`, inputTokens: 500 });
      await session.prompt(`[discord:${k} 2026-09-29 13:0${k} UTC]\nread the next notes`);
    };
    for (let k = 1; k <= 4; k++) await turn(k);

    const edits = session.sessionManager.getBranch().filter((e) => e.type === "context_edit");
    // Fired once, in turn 4 after its first read: results 1-2 are older than the last 3 turns and the last 8.
    expect(edits).toHaveLength(2);
    const last = reqs.at(-1)!.body.messages as Array<{ role: string; content: unknown }>;
    const tools = last.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
    expect(tools).toHaveLength(12);
    expect(tools[0]).toContain(`${CLEARED_PREFIX} read note1.md,`);
    expect(tools[1]).toContain(`${CLEARED_PREFIX} read note2.md,`);
    for (const t of tools.slice(2)) expect(t).toContain("lorem ipsum");
    // Each edit follows the tool result it clears: applied between turns, never mid-call.
    const branch = session.sessionManager.getBranch();
    for (const e of edits) {
      const target = branch.findIndex((b) => b.id === (e as { targetId: string }).targetId);
      expect(target).toBeGreaterThan(-1);
      expect(branch.indexOf(e)).toBeGreaterThan(target);
    }
    session.dispose();
  }, 30_000);
});

describe("!model on a real Pi session", () => {
  test("a switch applies from the next turn; chatgpt choices still fall back to OpenRouter, openrouter ones are pinned", async () => {
    const cfg = { ...config("chatgpt"), models: parseModelList("sol=chatgpt:gpt-6.1-sol,luna=chatgpt:gpt-6-luna,or-mini=openrouter:test/mini") };
    mkdirSync(cfg.stateDir, { recursive: true });
    const choice = new ModelChoice(cfg, cfg.stateDir);
    const selector = new BackendSelector({ primaryEnabled: true });
    const session = await open(cfg, { choice, selector });
    const ask = async (text: string) => {
      const before = reqs.length;
      await session.prompt(`[discord:x 2026-09-29 13:00 UTC]\n${text}`);
      return reqs.slice(before).map((r) => `${r.backend}:${String(r.body.model)}`);
    };
    expect(await ask("one")).toEqual(["chatgpt:gpt-6.1-sol"]);
    choice.select("or-mini");
    expect(await ask("two")).toEqual(["openrouter:test/mini"]);
    choice.select("luna");
    expect(await ask("three")).toEqual(["chatgpt:gpt-6-luna"]);
    chatgptDown = true;
    expect(await ask("four")).toEqual(["chatgpt:gpt-6-luna", "openrouter:openai/gpt-6-luna"]);
    session.dispose();
  }, 30_000);
});
