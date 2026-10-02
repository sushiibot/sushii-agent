import { clearOpenRouterCatalog } from "../agentRuntime/piShared.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS, type ChatDeliverParams } from "../orchestration/contracts.ts";
import { BackendSelector } from "./chatgptFallback.ts";
import type { WorkspaceConfig } from "./config.ts";
import { scaffoldHome } from "./home.ts";
import { runToolFreeJob } from "./jobSession.ts";
import { PersonalSession } from "./personalSession.ts";
import { createPiChatSessionFactory } from "./piChatSession.ts";
import { RunLog } from "./runLog.ts";
import { SubagentHost } from "./subagents/host.ts";
import { MainTurnTracker } from "./subagents/turnTracker.ts";

// Real Pi 0.99.1 sessions (main, a delegated child, a job and the auto-mode judge) on ONE selector; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";
const CHATGPT_MODEL = "gpt-6.1-sol";
const CHATGPT_JUDGE = "gpt-6-luna";
const OPENROUTER_MODEL = "openai/gpt-6-luna";
const OPENROUTER_JUDGE = "test/judge";
const JOB_MARKER = "ONE-BACKEND-JOB-7731";
const USAGE_LIMIT_BODY = { error: { code: "subscription_sharing_usage_limit_exceeded", type: "usage_limit_reached", message: "usage limit reached" } };

type Kind = "main" | "child" | "job" | "judge";
type Backend = "chatgpt" | "openrouter";
type Reply = { text?: string; tool?: { name: string; args: object } };
interface Req {
  backend: Backend;
  kind: Kind;
  model: string;
  body: Record<string, unknown>;
}

let root: string;
let reqs: Req[];
let script: Record<Kind, Reply[]>;
/** Every ChatGPT call answers with a usage limit. */
let chatgptDown: boolean;
/** Only the child's ChatGPT calls answer with a usage limit. */
let childLimited: boolean;
let clock: number;
/** Runs as each model request arrives, before it is answered. */
let onRequest: ((req: Req) => void) | null;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

const DEFAULTS: Record<Kind, Reply> = {
  main: { text: "main done" },
  child: { text: "child done" },
  job: { text: "job done" },
  judge: { text: "<verdict>allow</verdict> a harmless write in home" },
};

function kindOf(body: Record<string, unknown>): Kind {
  if (body.model === CHATGPT_JUDGE || body.model === OPENROUTER_JUDGE) return "judge";
  const text = JSON.stringify(body);
  if (text.includes("## Subagent rules")) return "child";
  if (text.includes(JOB_MARKER)) return "job";
  return "main";
}

function responsesSse(reply: Reply, n: number): Response {
  const ev = (o: { type: string }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  let out = ev({ type: "response.created", response: { id: `resp_${n}`, status: "in_progress" } } as { type: string });
  if (reply.tool) {
    const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: reply.tool.name, arguments: JSON.stringify(reply.tool.args), status: "completed" };
    out += ev({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } } as { type: string });
    out += ev({ type: "response.output_item.done", output_index: 0, item } as { type: string });
  } else {
    const text = reply.text ?? "";
    const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    out += ev({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } } as { type: string });
    out += ev({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text } as { type: string });
    out += ev({ type: "response.output_item.done", output_index: 0, item } as { type: string });
  }
  const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 };
  out += ev({ type: "response.completed", response: { id: `resp_${n}`, status: "completed", usage } } as { type: string });
  return new Response(out, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatCompletionsSse(reply: Reply, n: number): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: `gen-${n}`, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
    : { role: "assistant", content: reply.text ?? "" };
  const body = chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  clearOpenRouterCatalog();
  root = mkdtempSync(join(tmpdir(), "ws-one-backend-"));
  reqs = [];
  script = { main: [], child: [], job: [], judge: [] };
  chatgptDown = false;
  childLimited = false;
  clock = Date.parse("2026-09-29T12:00:00Z");
  onRequest = null;
  delete process.env.OPENAI_API_KEY;
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 24 * 3_600_000,
        clientId: "test-client",
        scopes: ["chatgpt.tokens.use.direct"],
      },
    }),
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Catalog lookups for context windows and prices, not model calls.
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return Response.json({ data: [{ id: "openai/gpt-6-luna", context_length: 800000 }, { id: "anthropic/claude-test", context_length: 800000 }] });
    const backend: Backend | null = url.startsWith("https://api.openai.com/") ? "chatgpt" : url.startsWith(`${OPENROUTER_BASE}/chat/completions`) ? "openrouter" : null;
    if (!backend) throw new Error(`unexpected fetch in test: ${url}`);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}");
    const body = JSON.parse(String(raw)) as Record<string, unknown>;
    const kind = kindOf(body);
    const req: Req = { backend, kind, model: String(body.model), body };
    reqs.push(req);
    onRequest?.(req);
    if (backend === "chatgpt" && (chatgptDown || (childLimited && kind === "child"))) {
      return new Response(JSON.stringify(USAGE_LIMIT_BODY), { status: 429, headers: { "content-type": "application/json" } });
    }
    const reply = script[kind].shift() ?? DEFAULTS[kind];
    return backend === "chatgpt" ? responsesSse(reply, reqs.length) : chatCompletionsSse(reply, reqs.length);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  clearOpenRouterCatalog();
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

function config(): WorkspaceConfig {
  return {
    provider: "chatgpt",
    chatgptModel: CHATGPT_MODEL,
    model: OPENROUTER_MODEL,
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
    principalId: "drk",
    autoMode: true,
    judgeModel: OPENROUTER_JUDGE,
    judgeChatgptModel: CHATGPT_JUDGE,
  } as WorkspaceConfig;
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The index.ts wiring in miniature: one selector handed to main, the subagent host and the jobs. */
async function workspace() {
  const cfg = config();
  await scaffoldHome(cfg.home);
  const runs = new RunLog(cfg.stateDir);
  const selector = new BackendSelector({ primaryEnabled: true, now: () => clock });
  const delivered: ChatDeliverParams[] = [];
  const turns = new MainTurnTracker();
  const notify = (method: string, params: unknown) => turns.observe(method, params);
  const subagents = new SubagentHost({ config: cfg, runs, selector, notify, currentTurn: () => turns.current() });
  const personal = new PersonalSession({
    principalId: "drk",
    model: cfg.model,
    stateDir: cfg.stateDir,
    factory: createPiChatSessionFactory(cfg, { runs, selector, subagents }),
    transport: {
      request: async (method, params) => {
        if (method === RPC_METHODS.chatDeliver) delivered.push(params as ChatDeliverParams);
        return {};
      },
      notify,
    },
    textDeltaMs: null,
  });
  await personal.start();
  let n = 0;
  const say = async (text: string) => {
    const before = delivered.length;
    await personal.handleMessage({
      principalId: "drk",
      origin: { surface: "discord", conversationId: "dm" },
      messageId: `m${++n}`,
      text,
      kind: "user",
      author: { id: "1", name: "drk" },
    });
    await until(() => delivered.length > before);
    return delivered.at(-1)!;
  };
  const job = () => runToolFreeJob(cfg, { agentName: "job:test", systemPrompt: `Scheduled job ${JOB_MARKER}.`, prompt: "go", runs, selector });
  const dispose = async () => {
    await subagents.dispose();
    await personal.dispose();
  };
  return { cfg, runs, selector, personal, say, job, dispose };
}

/** One main turn that uses every component: a judged bash call, then a delegated child. */
function scriptJudgedDelegation(): void {
  script.main.push({ tool: { name: "bash", args: { command: "echo hi > hi.txt" } } }, { tool: { name: "delegate", args: { agent: "explore", task: "look around" } } }, { text: "main done" });
}

const backendsOf = (rs: Req[]) => [...new Set(rs.map((r) => r.backend))];
const kindsOf = (rs: Req[]) => [...new Set(rs.map((r) => r.kind))].sort();

describe("one shared backend on real Pi sessions", () => {
  test("on ChatGPT, main, child, job and judge all call api.openai.com and never OpenRouter", async () => {
    const w = await workspace();
    scriptJudgedDelegation();
    const deliver = await w.say("do things");
    await w.job();

    expect(kindsOf(reqs)).toEqual(["child", "job", "judge", "main"]);
    expect(backendsOf(reqs)).toEqual(["chatgpt"]);
    expect(reqs.filter((r) => r.kind !== "judge").every((r) => r.model === CHATGPT_MODEL)).toBe(true);
    const judge = reqs.find((r) => r.kind === "judge")!;
    expect(judge.model).toBe(CHATGPT_JUDGE);
    // Luna maps thinking "off" to effort "none", so the verdict isn't starved by reasoning tokens.
    expect(judge.body.reasoning).toEqual({ effort: "none" });

    // Footer and run log name the model that actually answered.
    expect(deliver.usage?.model).toBe(`chatgpt/${CHATGPT_MODEL}`);
    const [main] = w.runs.listRuns({ agentName: "main" });
    const [child] = w.runs.listRuns({ agentName: "explore" });
    const [job] = w.runs.listRuns({ agentName: "job:test" });
    expect(main!.usage?.model).toBe(`chatgpt/${CHATGPT_MODEL}`);
    expect(child!.usage?.model).toBe(`chatgpt/${CHATGPT_MODEL}`);
    expect(child!.usage?.costUsd).toBeUndefined();
    expect(job!.usage?.model).toBe(`chatgpt/${CHATGPT_MODEL}`);
    await w.dispose();
  });

  test("a shared cool-down moves main, child, job and judge to OpenRouter together, and back together", async () => {
    const w = await workspace();
    chatgptDown = true;
    scriptJudgedDelegation();
    const first = await w.say("do things");
    await w.job();

    // Only main's first attempt reached ChatGPT; its limit flipped the selector for everyone.
    expect(reqs.filter((r) => r.backend === "chatgpt").map((r) => r.kind)).toEqual(["main"]);
    const after = reqs.slice(1);
    expect(kindsOf(after)).toEqual(["child", "job", "judge", "main"]);
    expect(backendsOf(after)).toEqual(["openrouter"]);
    expect(after.find((r) => r.kind === "judge")!.model).toBe(OPENROUTER_JUDGE);
    expect(after.find((r) => r.kind === "child")!.model).toBe(OPENROUTER_MODEL);
    expect(w.selector.coolingDownUntil).not.toBeNull();
    expect(first.usage?.model).toBe(OPENROUTER_MODEL);
    expect(w.runs.listRuns({ agentName: "explore" })[0]!.usage?.model).toBe(OPENROUTER_MODEL);
    expect(w.runs.listRuns({ agentName: "job:test" })[0]!.usage?.model).toBe(OPENROUTER_MODEL);

    // Past the cool-down every component starts on ChatGPT again.
    chatgptDown = false;
    clock += 2 * 60 * 60_000;
    const mark = reqs.length;
    scriptJudgedDelegation();
    const second = await w.say("again");
    await w.job();
    const back = reqs.slice(mark);
    expect(kindsOf(back)).toEqual(["child", "job", "judge", "main"]);
    expect(backendsOf(back)).toEqual(["chatgpt"]);
    expect(back.find((r) => r.kind === "judge")!.model).toBe(CHATGPT_JUDGE);
    expect(second.usage?.model).toBe(`chatgpt/${CHATGPT_MODEL}`);
    await w.dispose();
  });

  test("a child on the limit flips the shared selector and retries once on OpenRouter", async () => {
    const w = await workspace();
    childLimited = true;
    script.main.push({ tool: { name: "delegate", args: { agent: "explore", task: "look around" } } }, { text: "main done" });
    script.child.push({ text: "found it on openrouter" });
    await w.say("look");

    const childReqs = reqs.filter((r) => r.kind === "child");
    expect(childReqs.map((r) => r.backend)).toEqual(["chatgpt", "openrouter"]);
    expect(w.selector.coolingDownUntil).not.toBeNull();
    const [child] = w.runs.listRuns({ agentName: "explore" });
    expect(child).toMatchObject({ status: "done" });
    expect(child!.usage?.model).toBe(OPENROUTER_MODEL);
    // Main's request after the delegate call, in the same run, follows the flip too.
    const mainAfter = reqs.filter((r) => r.kind === "main").at(-1)!;
    expect(JSON.stringify(mainAfter.body)).toContain("found it on openrouter");
    expect(reqs.filter((r) => r.kind === "main").map((r) => r.backend)).toEqual(["chatgpt", "openrouter"]);

    // The flip is shared: the next job starts on OpenRouter without trying ChatGPT.
    const mark = reqs.length;
    await w.job();
    expect(reqs.slice(mark).map((r) => r.backend)).toEqual(["openrouter"]);
    await w.dispose();
  });

  test("a cool-down ending mid-run moves the running child and main back to ChatGPT at their next request", async () => {
    const w = await workspace();
    w.selector.onChatGptFailure("usage limit reached");
    script.main.push({ tool: { name: "delegate", args: { agent: "explore", task: "look around" } } }, { text: "main done" });
    script.child.push({ tool: { name: "ls", args: { path: "." } } }, { text: "child done" });
    onRequest = (req) => {
      if (req.kind === "child" && req.backend === "openrouter") clock += 2 * 60 * 60_000;
    };
    await w.say("look");

    expect(reqs.filter((r) => r.kind === "child").map((r) => r.backend)).toEqual(["openrouter", "chatgpt"]);
    expect(reqs.filter((r) => r.kind === "main").map((r) => r.backend)).toEqual(["openrouter", "chatgpt"]);
    expect(w.selector.coolingDownUntil).toBeNull();
    await w.dispose();
  });

  test("a def pinned to an OpenRouter model uses exactly that model while everything else stays on ChatGPT", async () => {
    const cfg = config();
    mkdirSync(join(cfg.home, ".agents", "agents"), { recursive: true });
    writeFileSync(
      join(cfg.home, ".agents", "agents", "pinned.md"),
      "---\nname: pinned\ndescription: pinned to an OpenRouter model\ntools: Read\nmodel: openrouter/anthropic/claude-test\n---\nAnswer briefly.\n",
    );
    const w = await workspace();
    script.main.push({ tool: { name: "delegate", args: { agent: "pinned", task: "answer" } } }, { text: "main done" });
    await w.say("ask pinned");

    const child = reqs.filter((r) => r.kind === "child");
    expect(child.map((r) => [r.backend, r.model])).toEqual([["openrouter", "anthropic/claude-test"]]);
    expect(backendsOf(reqs.filter((r) => r.kind !== "child"))).toEqual(["chatgpt"]);
    expect(w.selector.coolingDownUntil).toBeNull();
    expect(w.runs.listRuns({ agentName: "pinned" })[0]!.usage?.model).toBe("anthropic/claude-test");
    await w.dispose();
  });
});
