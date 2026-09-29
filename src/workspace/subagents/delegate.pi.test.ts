import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RPC_METHODS, type ChatDeliverParams, type ChatEventParams, type ToolCallParams, type ToolManifestEntry } from "../../orchestration/contracts.ts";
import { runnerGit } from "../../orchestration/runner/runnerGit.ts";
import type { WorkspaceConfig } from "../config.ts";
import { scaffoldHome } from "../home.ts";
import { PersonalSession, type ChatTransport } from "../personalSession.ts";
import { createPiChatSessionFactory } from "../piChatSession.ts";
import { RunLog } from "../runLog.ts";
import { ToolStubs } from "../toolStubs.ts";
import { runWsRuns } from "../wsRuns.ts";
import { SubagentHost, type SubagentLimits } from "./host.ts";
import { MainTurnTracker } from "./turnTracker.ts";

// Real Pi 0.99.1 sessions (main from the workspace factory, children from the delegate host); the only fake is fetch.
const BASE = "http://openrouter.test/v1";

type Reply = { text?: string; tool?: { name: string; args: object } };
type Body = { messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ id: string; function: { name: string } }> }>; tools?: Array<{ function: { name: string } }> };
type Responder = (body: Body) => Reply | Promise<Reply>;

let root: string;
let bodies: Body[];
let respond: Responder;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

function sse(reply: Reply, n: number): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
    : { role: "assistant", content: reply.text ?? "" };
  const body = chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const system = (b: Body) => String(b.messages[0]?.content ?? "");
const isChild = (b: Body) => system(b).includes("## Subagent rules");
const childRun = (b: Body) => /runId (\w+)\)/.exec(system(b))?.[1] ?? "";
const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function.name).sort();
const lastMessage = (b: Body) => JSON.stringify(b.messages.at(-1));
const text = (b: Body) => JSON.stringify(b.messages);
/** The i-th request of the main session / of any child. */
const mainTurn = (b: Body) => bodies.filter((x) => !isChild(x)).indexOf(b);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-delegate-"));
  bodies = [];
  respond = () => ({ text: "unscripted" });
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (!url.startsWith(`${BASE}/chat/completions`)) throw new Error(`unexpected fetch in test: ${url}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    bodies.push(body);
    const n = bodies.length;
    const signal = init?.signal;
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    return sse(await Promise.race([respond(body), aborted]), n);
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
    baseUrl: BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
    principalId: "drk",
  } as WorkspaceConfig;
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SEARCH: ToolManifestEntry = {
  name: "web_search",
  description: "Search the web.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  approval: "none",
};

async function host(limits: Partial<SubagentLimits> = {}) {
  const cfg = config();
  await scaffoldHome(cfg.home);
  const runs = new RunLog(cfg.stateDir);
  const delivered: ChatDeliverParams[] = [];
  const events: ChatEventParams[] = [];
  const toolCalls: ToolCallParams[] = [];
  const turns = new MainTurnTracker();
  const toolStubs = new ToolStubs({
    principalId: "drk",
    request: async (method, params) => {
      if (method === RPC_METHODS.toolCall) toolCalls.push(params as ToolCallParams);
      return { ok: true, result: "search hits" };
    },
  });
  toolStubs.update([SEARCH]);
  const notify = (method: string, params: unknown) => {
    turns.observe(method, params);
    if (method === RPC_METHODS.chatEvent) events.push(params as ChatEventParams);
  };
  const subagents = new SubagentHost({ config: cfg, runs, toolStubs, notify, currentTurn: () => turns.current(), limits });
  const transport: ChatTransport = {
    request: async (method, params) => {
      if (method === RPC_METHODS.chatDeliver) delivered.push(params as ChatDeliverParams);
      return {};
    },
    notify,
  };
  const personal = new PersonalSession({
    principalId: "drk",
    model: cfg.model,
    stateDir: cfg.stateDir,
    factory: createPiChatSessionFactory(cfg, { runs, toolStubs, subagents }),
    transport,
    textDeltaMs: null,
  });
  await personal.start();
  const dispose = async () => {
    await personal.dispose();
    await subagents.dispose();
  };
  return { cfg, runs, personal, subagents, delivered, events, toolCalls, dispose };
}

const user = (messageId: string, t: string) => ({
  principalId: "drk",
  origin: { surface: "discord", conversationId: "dm" },
  messageId,
  text: t,
  kind: "user" as const,
  author: { id: "1", name: "drk" },
});

function wsRuns(cfg: WorkspaceConfig, args: string[]): string {
  const out: string[] = [];
  const err: string[] = [];
  runWsRuns(args, { env: { WORKSPACE_STATE_DIR: cfg.stateDir }, agentDirs: [cfg.agentDir], out: (l) => out.push(l), err: (l) => err.push(l) });
  return [...out, ...err].join("\n");
}

describe("delegate on real Pi sessions", () => {
  test("foreground: capped result + runId, run-log linkage, nested progress, ws-runs transcript, bot tools carry agentId", async () => {
    const h = await host({ resultChars: 100 });
    const long = `FINDING ${"x".repeat(300)}`;
    let childStep = 0;
    respond = (b) => {
      if (isChild(b)) {
        childStep++;
        if (childStep === 1) return { tool: { name: "ls", args: { path: "." } } };
        if (childStep === 2) return { tool: { name: "web_search", args: { query: "pi subagents" } } };
        return { text: long };
      }
      return mainTurn(b) === 0 ? { tool: { name: "delegate", args: { agent: "explore", task: "map the home dir" } } } : { text: "main done" };
    };
    await h.personal.handleMessage(user("m1", "look around"));
    await until(() => h.delivered.length === 1);
    expect(h.delivered[0].text).toBe("main done");

    const main = h.runs.listRuns({ agentName: "main" })[0];
    const [child] = h.runs.listRuns({ agentName: "explore" });
    expect(child).toMatchObject({ parentRunId: main.runId, status: "done", task: "map the home dir" });
    expect(child.sessionFile).toStartWith(join(h.cfg.agentDir, "subagents", main.runId) + "/");

    // The main model saw the capped result with the runId, not the whole child output.
    const toolResult = lastMessage(bodies.filter((b) => !isChild(b))[1]);
    expect(toolResult).toContain(`runId ${child.runId}`);
    expect(toolResult).toContain("cut at 100 of");
    expect(toolResult).toContain(`ws-runs show ${child.runId}`);
    expect(toolResult).not.toContain("x".repeat(200));

    // Children are leaves with the def's tools plus the bot tools; no delegate, no ask/messaging tools.
    const childBody = bodies.find(isChild)!;
    expect(toolNames(childBody)).toEqual(["find", "grep", "ls", "read", "web_search"]);
    expect(toolNames(bodies[0])).toContain("delegate");

    // tool/call from the child names it.
    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0]).toMatchObject({ name: "web_search", agentId: child.runId, agentName: "explore", parentRunId: main.runId });

    // Child progress nests under the main turn.
    const mainTurnId = h.events.find((e) => e.agentId === "main" && e.ev.type === "turn_start")!.turnId;
    const childEvents = h.events.filter((e) => e.agentId === child.runId);
    expect(childEvents.map((e) => e.ev.type)).toEqual(["turn_start", "tool_start", "tool_end", "tool_start", "tool_end", "turn_end"]);
    for (const e of childEvents) expect(e).toMatchObject({ turnId: mainTurnId, parentRunId: main.runId, origin: { surface: "discord", conversationId: "dm" } });

    // ws-runs shows the child's own transcript.
    const shown = wsRuns(h.cfg, ["show", child.runId, "--full"]);
    expect(shown).toContain("map the home dir");
    expect(shown).toContain("FINDING");
    expect(wsRuns(h.cfg, ["list", "--parent", main.runId])).toContain(child.runId);
    await h.dispose();
  }, 30_000);

  test("fork starts the child from the parent's branch; continue reopens a finished child", async () => {
    const h = await host();
    respond = (b) => {
      if (isChild(b)) return { text: text(b).includes("second pass") ? "child: second" : "child: first" };
      const i = mainTurn(b);
      if (i === 0) return { text: "noted the codeword" };
      if (i === 1) return { tool: { name: "delegate", args: { agent: "explore", task: "what is the codeword?", mode: "fork" } } };
      return { text: "ok" };
    };
    await h.personal.handleMessage(user("m1", "the codeword is banana"));
    await until(() => h.delivered.length === 1);
    await h.personal.handleMessage(user("m2", "ask a child"));
    await until(() => h.delivered.length === 2);

    const forked = bodies.find(isChild)!;
    expect(text(forked)).toContain("the codeword is banana");
    expect(text(forked)).toContain("noted the codeword");
    // The in-flight delegate call is not in the fork (it would have no tool result).
    expect(text(forked)).not.toContain('"name":"delegate"');
    expect(forked.messages.filter((m) => m.role === "assistant").every((m) => !m.tool_calls?.length)).toBe(true);

    const [child] = h.runs.listRuns({ agentName: "explore" });
    const header = JSON.parse(readFileSync(child.sessionFile, "utf8").split("\n")[0]);
    expect(header.parentSession).toBe(h.personal.currentSessionFile);

    // Continue: a follow-up in the child's own session.
    respond = (b) => {
      if (isChild(b)) return { text: text(b).includes("second pass") ? "child: second" : "child: first" };
      return mainTurn(b) === 3 ? { tool: { name: "delegate", args: { continue: child.runId, task: "second pass please" } } } : { text: "ok again" };
    };
    await h.personal.handleMessage(user("m3", "follow up"));
    await until(() => h.delivered.length === 3);
    const resumed = bodies.filter(isChild).at(-1)!;
    expect(text(resumed)).toContain("what is the codeword?");
    expect(text(resumed)).toContain("child: first");
    expect(text(resumed)).toContain("second pass please");
    const runsNow = h.runs.listRuns({ agentName: "explore" });
    expect(runsNow).toHaveLength(2);
    expect(runsNow[0].sessionFile).toBe(child.sessionFile);
    expect(runsNow[0].status).toBe("done");
    await h.dispose();
  }, 30_000);

  test("background: returns at once, then the result wakes main and its reply goes out through the outbox", async () => {
    const h = await host();
    let releaseChild!: () => void;
    const childGate = new Promise<void>((r) => (releaseChild = r));
    respond = async (b) => {
      if (isChild(b)) {
        await childGate;
        return { text: "bg finding: 42" };
      }
      const i = mainTurn(b);
      if (i === 0) return { tool: { name: "delegate", args: { agent: "explore", task: "slow digging", background: true } } };
      if (i === 1) return { text: "started it" };
      return { text: lastMessage(b).includes("bg finding: 42") ? "the answer is 42" : "no result" };
    };
    await h.personal.handleMessage(user("m1", "dig in the background"));
    await until(() => h.delivered.length === 1);
    expect(h.delivered[0].text).toBe("started it");
    expect(lastMessage(bodies.filter((b) => !isChild(b))[1])).toContain("in the background");
    expect(h.runs.listRuns({ agentName: "explore" })[0].status).toBe("running");

    releaseChild();
    await until(() => h.delivered.length === 2);
    expect(h.delivered[1]).toMatchObject({ text: "the answer is 42", origin: { surface: "discord", conversationId: "dm" } });
    const woke = bodies.filter((b) => !isChild(b))[2];
    expect(lastMessage(woke)).toContain("subagent-result");
    expect(h.runs.listRuns({ agentName: "explore" })[0].status).toBe("done");
    await h.dispose();
  }, 30_000);

  test("a child can't write memory files", async () => {
    const h = await host();
    writeFileSync(join(h.cfg.home, ".agents/agents/scribe.md"), "---\nname: scribe\ndescription: writes\ntools: Read, Write, Edit, Bash\nbackground: true\n---\nYou write.\n");
    const before = readFileSync(join(h.cfg.home, "MEMORY.md"), "utf8");
    await runnerGit(join(h.cfg.home, "projects")).init();
    mkdirSync(join(h.cfg.home, "projects", "repo"));
    await runnerGit(join(h.cfg.home, "projects", "repo")).init();
    const g = runnerGit(join(h.cfg.home, "projects", "repo"));
    await g.addConfig("user.name", "t").addConfig("user.email", "t@t").addConfig("commit.gpgsign", "false");
    writeFileSync(join(h.cfg.home, "projects", "repo", "a.txt"), "a\n");
    await g.add(".").commit("init");
    let step = 0;
    respond = (b) => {
      if (isChild(b)) {
        step++;
        if (step === 1) return { tool: { name: "write", args: { path: join(h.cfg.home, "MEMORY.md"), content: "- child fact\n" } } };
        if (step === 2) return { tool: { name: "bash", args: { command: `echo x >> ${join(h.cfg.home, "memory/2026-09-29.md")}` } } };
        return { text: "could not save" };
      }
      const i = mainTurn(b);
      if (i === 0) return { tool: { name: "delegate", args: { agent: "scribe", task: "save a fact", repo: "repo" } } };
      return { text: i === 1 ? "started" : "done" };
    };
    await h.personal.handleMessage(user("m1", "go"));
    // The def says background, so the call returns at once and the result wakes main later.
    await until(() => h.delivered.length === 2);
    expect(lastMessage(bodies.filter((b) => !isChild(b))[1])).toContain("in the background");
    expect(readFileSync(join(h.cfg.home, "MEMORY.md"), "utf8")).toBe(before);
    const childBodies = bodies.filter(isChild);
    expect(lastMessage(childBodies[1])).toContain("subagents can't write");
    expect(lastMessage(childBodies[2])).toContain("subagents can't write");
    // The writer ran in its own worktree on a new branch.
    const toolResult = lastMessage(bodies.filter((b) => !isChild(b))[2]);
    expect(toolResult).toMatch(/Worktree: .*projects\/repo-wt-\w+ \(branch agent\/\w+\)/);
    await h.dispose();
  }, 30_000);

  test("depth: children are leaves by default; with maxDepth 2 a child can delegate once more", async () => {
    const h = await host({ maxDepth: 2 });
    respond = (b) => {
      if (isChild(b)) {
        const grand = !toolNames(b).includes("delegate");
        if (grand) return { text: "grandchild says hi" };
        return b.messages.some((m) => m.role === "tool") ? { text: "child relays" } : { tool: { name: "delegate", args: { agent: "explore", task: "go deeper", background: true } } };
      }
      return mainTurn(b) === 0 ? { tool: { name: "delegate", args: { agent: "explore", task: "top" } } } : { text: "done" };
    };
    await h.personal.handleMessage(user("m1", "nest"));
    await until(() => h.delivered.length === 1);
    const all = h.runs.listRuns({ agentName: "explore" });
    expect(all).toHaveLength(2);
    const main = h.runs.listRuns({ agentName: "main" })[0];
    const child = all.find((r) => r.parentRunId === main.runId)!;
    const grand = all.find((r) => r !== child)!;
    expect(grand.parentRunId).toBe(child.runId);
    // Nested children run in the foreground even when asked for background.
    expect(grand.status).toBe("done");
    expect(JSON.stringify(bodies.filter(isChild).find((b) => b.messages.some((m) => m.role === "tool"))?.messages)).toContain("grandchild says hi");
    await h.dispose();
  }, 30_000);
});

describe("limits, driving the host directly", () => {
  const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => [] } } as unknown as Pick<ExtensionContext, "sessionManager">;
  const parent = { depth: 0, currentRunId: () => "PARENTRUN" };

  async function direct(limits: Partial<SubagentLimits>) {
    const cfg = config();
    await scaffoldHome(cfg.home);
    const runs = new RunLog(cfg.stateDir);
    const host = new SubagentHost({ config: cfg, runs, limits });
    const pi = { sendMessage: () => {} } as never;
    const call = (task: string, extra: object = {}) => host.delegate({ agent: "explore", task, ...extra }, { parent, pi, toolCallId: "t", ctx });
    return { cfg, runs, host, call };
  }

  test("at most maxReaders read-only children run at once; the rest wait for a slot", async () => {
    const { host, call } = await direct({ maxReaders: 3 });
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    respond = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return { text: "done" };
    };
    const all = Promise.all([call("a"), call("b"), call("c"), call("d")]);
    await until(() => gates.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(inFlight).toBe(3);
    while (gates.length) gates.shift()!();
    await until(() => gates.length === 1);
    gates.shift()!();
    const results = await all;
    expect(results.map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
    expect(peak).toBe(3);
    await host.dispose();
  }, 30_000);

  test("shutdown aborts running children and fails queued ones, recording both", async () => {
    const { host, call, runs } = await direct({ maxReaders: 1 });
    respond = () => new Promise<Reply>(() => {});
    const first = call("runs");
    await until(() => bodies.length === 1);
    const second = call("waits");
    await new Promise((r) => setTimeout(r, 50));
    await host.dispose();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("aborted");
    expect(b.status).toBe("failed");
    expect(runs.getRun(a.runId)?.status).toBe("aborted");
    expect(runs.getRun(b.runId)?.status).toBe("failed");
  }, 30_000);

  test("turn cap: a steer to wrap up, then a hard abort after the grace turns", async () => {
    const { host, call, runs } = await direct({ maxTurns: 2, graceTurns: 1 });
    respond = () => ({ tool: { name: "ls", args: { path: "." } } });
    const out = await call("loop forever");
    expect(out.text).toContain("turn cap");
    expect(out.status).toBe("aborted");
    expect(runs.getRun(out.runId)?.status).toBe("aborted");
    expect(JSON.stringify(bodies.at(-1)!.messages)).toContain("turn limit");
    await host.dispose();
  }, 30_000);

  test("wall-clock cap: a stuck child is aborted and recorded as timeout", async () => {
    const { host, call, runs } = await direct({ foregroundTimeoutMs: 200 });
    respond = () => new Promise<Reply>((r) => setTimeout(() => r({ text: "too late" }), 5000));
    const started = Date.now();
    const out = await call("hang");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.status).toBe("timeout");
    expect(out.text).toContain("wall-clock cap");
    expect(runs.getRun(out.runId)?.status).toBe("timeout");
    await host.dispose();
  }, 30_000);

  test("token cap aborts a child that spends past it", async () => {
    const { host, call } = await direct({ maxTokens: 20 });
    respond = () => ({ tool: { name: "ls", args: { path: "." } } });
    const out = await call("spend");
    expect(out.status).toBe("aborted");
    expect(out.text).toContain("token cap");
    await host.dispose();
  }, 30_000);

  test("continue refuses unknown, running and non-subagent runs", async () => {
    const { host, call, runs } = await direct({});
    const main = runs.startRun({ agentName: "main", task: "x", sessionFile: "/nope" });
    await expect(call("again", { continue: main })).rejects.toThrow("no subagent run");
    await expect(call("again", { continue: "01NOPE" })).rejects.toThrow("no subagent run");
    const live = runs.startRun({ agentName: "explore", parentRunId: main, task: "x", sessionFile: "/nope" });
    await expect(call("again", { continue: live })).rejects.toThrow("still running");
    await host.dispose();
  });
});
