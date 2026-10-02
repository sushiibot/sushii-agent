import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RPC_METHODS, type ChatDeliverParams, type ChatEventParams, type ToolCallParams, type ToolManifestEntry } from "../../orchestration/contracts.ts";
import { runnerGit } from "../../agentRuntime/runnerGit.ts";
import type { WorkspaceConfig } from "../config.ts";
import { BackendSelector } from "../chatgptFallback.ts";
import { runFileRel } from "../history.ts";
import { scaffoldHome } from "../home.ts";
import { PersonalSession, type ChatTransport } from "../personalSession.ts";
import { createPiChatSessionFactory } from "../piChatSession.ts";
import { RunLog } from "../runLog.ts";
import { ToolStubs } from "../toolStubs.ts";
import { GitHubCredentials, type GitHubCredentialsOptions } from "../githubCredentials.ts";
import { runWsRuns } from "../wsRuns.ts";
import { SubagentHost, type SubagentHostOptions, type SubagentLimits } from "./host.ts";
import { PendingResults } from "./pendingResults.ts";
import { MainTurnTracker } from "./turnTracker.ts";

// Real Pi 0.99.1 sessions (main from the workspace factory, children from the delegate host); the only fake is fetch.
const BASE = "http://openrouter.test/v1";

type Reply = { text?: string; tool?: { name: string; args: object }; usage?: object };
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
  const usage = reply.usage ?? { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
  const body = chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop", { usage }) + "data: [DONE]\n\n";
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

async function host(limits: Partial<SubagentLimits> = {}, githubRequest?: GitHubCredentialsOptions["request"]) {
  const cfg = config();
  await scaffoldHome(cfg.home);
  const runs = new RunLog(cfg.stateDir);
  const selector = new BackendSelector({ primaryEnabled: cfg.provider === "chatgpt" });
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
  let personalRef: PersonalSession | null = null;
  let watchRef: SubagentHost["watch"] | null = null;
  const github = githubRequest
    ? new GitHubCredentials({ principalId: "drk", home: cfg.home, askpassPath: join(cfg.stateDir, "git-askpass.sh"), request: githubRequest, leaseWrite: (p) => watchRef!.mainWrite(p) })
    : undefined;
  const subagents = new SubagentHost({
    config: cfg,
    runs,
    selector,
    toolStubs,
    github,
    notify,
    currentTurn: () => turns.current(),
    limits,
    wake: (r, consumed) => personalRef?.wake({ id: r.runId, text: r.text, origin: r.origin, onConsumed: consumed }),
  });
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
    factory: createPiChatSessionFactory(cfg, { runs, toolStubs, subagents, selector, github }),
    transport,
    textDeltaMs: null,
  });
  watchRef = subagents.watch;
  await personal.start();
  personalRef = personal;
  const dispose = async () => {
    await subagents.dispose();
    await personal.dispose();
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
    expect(toolResult).toContain(`Transcript: ~/history/${runFileRel(child.runId, new Date(child.startedAt), h.cfg.tz)}`);
    expect(toolResult).toContain(`ws-runs show ${child.runId} --full`);
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
      if (i === 0) return { tool: { name: "delegate", args: { agent: "explore", task: "slow digging", background: true, taskId: "t-dig1" } } };
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
    const runId = h.runs.listRuns({ agentName: "explore" })[0].runId;
    // Started for a task: the result tells main to note it on that TASKS.md item.
    expect(lastMessage(woke)).toContain(`was for task t-dig1: note its outcome and run:${runId}`);
    expect(h.runs.listRuns({ agentName: "explore" })[0].status).toBe("done");
    await h.dispose();
  }, 30_000);

  test("Stop targets one background child after the parent replied", async () => {
    const h = await host();
    let releaseChild!: () => void;
    const gate = new Promise<void>((r) => { releaseChild = r; });
    respond = async (b) => {
      if (isChild(b)) { await gate; return { text: "late child result" }; }
      if (mainTurn(b) === 0) return { tool: { name: "delegate", args: { agent: "explore", task: "inspect background", background: true } } };
      return { text: "parent is available" };
    };
    await h.personal.handleMessage(user("stop-target", "start background work"));
    await until(() => h.delivered.length === 1 && bodies.some(isChild));
    const child = h.runs.listRuns({ agentName: "explore" })[0];
    expect(child.conversationId).toBe("main");
    expect(h.subagents.stop("unknown")).toBe(false);
    expect(h.subagents.stop(child.runId)).toBe(true);
    await until(() => h.runs.getRun(child.runId)?.status === "aborted");
    expect(h.subagents.stop(child.runId)).toBe(false);
    releaseChild();
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

  test("a coder that deletes a memory file through bash is stopped, the file restored, and main told why", async () => {
    const h = await host();
    await initRepo(h.cfg.home, "repo");
    const memoryPath = join(h.cfg.home, "MEMORY.md");
    writeFileSync(memoryPath, "- drk likes tea\n");
    let step = 0;
    respond = (b) => {
      if (isChild(b)) {
        step++;
        // `rm` names no redirect or copy, so the bash text guard lets it through; the watch catches it.
        if (step === 1) return { tool: { name: "bash", args: { command: `rm ${memoryPath} && echo gone` } } };
        return { text: "deleted it" };
      }
      return mainTurn(b) === 0 ? { tool: { name: "delegate", args: { agent: "coder", task: "clean up", repo: "repo", background: false } } } : { text: "done" };
    };
    await h.personal.handleMessage(user("m1", "go"));
    await until(() => h.delivered.length === 1);
    expect(readFileSync(memoryPath, "utf8")).toBe("- drk likes tea\n");
    const [child] = h.runs.listRuns({ agentName: "coder" });
    expect(child.status).toBe("failed");
    // The child's bash result became the notice, and the child was stopped before another model call.
    expect(bodies.filter(isChild)).toHaveLength(1);
    expect(readFileSync(child.sessionFile, "utf8")).toContain("changed protected paths (MEMORY.md)");
    const toMain = lastMessage(bodies.filter((b) => !isChild(b))[1]);
    expect(toMain).toContain("changed protected paths");
    expect(toMain).toContain("MEMORY.md");
    await h.dispose();
  }, 30_000);

  test("GitHub credentials: a coder's bash and main's bash both get the repo's token; the guard install isn't tamper", async () => {
    const token = "ghs_coderCoderCoder0123456789";
    const requested: string[] = [];
    const h = await host({}, async (method, params) => {
      if (method === RPC_METHODS.githubToken) requested.push((params as { repo: string }).repo);
      return { ok: true, token, expiresAt: Date.now() + 3600_000, botName: "sushii-runner[bot]", botEmail: "runner@x" };
    });
    await initRepo(h.cfg.home, "acme-widgets");
    await runnerGit(join(h.cfg.home, "projects", "acme-widgets")).addRemote("origin", "https://github.com/acme/widgets.git");
    let step = 0;
    respond = (b) => {
      if (isChild(b)) {
        step++;
        if (step === 1) return { tool: { name: "bash", args: { command: 'printf "child:%s:%s" "$GH_TOKEN" "$GIT_COMMITTER_EMAIL"' } } };
        return { text: "coded" };
      }
      const turn = mainTurn(b);
      if (turn === 0) return { tool: { name: "delegate", args: { agent: "coder", task: "fix", repo: "acme-widgets", background: false } } };
      if (turn === 1) return { tool: { name: "bash", args: { command: 'cd projects/acme-widgets && printf "main:%s:%s" "$GH_TOKEN" "$GIT_AUTHOR_NAME"' } } };
      return { text: "done" };
    };
    await h.personal.handleMessage(user("m1", "go"));
    await until(() => h.delivered.length === 1);
    const [child] = h.runs.listRuns({ agentName: "coder" });
    expect(child.status).toBe("done");
    expect(text(bodies.filter(isChild).at(-1)!)).toContain(`child:${token}:runner@x`);
    expect(text(bodies.filter((b) => !isChild(b)).at(-1)!)).toContain(`main:${token}:sushii-runner[bot]`);
    expect(readFileSync(join(h.cfg.home, "projects", "acme-widgets", ".git", "hooks", "pre-push"), "utf8")).toContain("default branch");
    expect(requested).toEqual(["acme/widgets"]);
    await h.dispose();
  }, 30_000);

  test("read-only defs get no bash tool, even when their file lists Bash", async () => {
    const h = await host();
    writeFileSync(join(h.cfg.home, ".agents/agents/legacy.md"), "---\nname: legacy\ndescription: old reviewer\ntools: Read, Grep, Bash\n---\nReview.\n");
    const seen = new Map<string, string[]>();
    let call = 0;
    respond = (b) => {
      if (isChild(b)) {
        seen.set(/`(\w+)` subagent/.exec(system(b))?.[1] ?? "?", toolNames(b));
        return { text: "ok" };
      }
      const agents = ["researcher", "reviewer", "explore", "legacy"];
      return call < agents.length ? { tool: { name: "delegate", args: { agent: agents[call++], task: "look" } } } : { text: "done" };
    };
    await h.personal.handleMessage(user("m1", "go"));
    await until(() => h.delivered.length === 1);
    for (const name of ["researcher", "reviewer", "explore"]) expect(seen.get(name)).toEqual(["find", "grep", "ls", "read", "web_search"]);
    expect(seen.get("legacy")).toEqual(["grep", "read", "web_search"]);
    await h.dispose();
  }, 30_000);

  test("a background result answers on the spawn-time origin, and its record is consumed once main has it", async () => {
    const h = await host();
    const WEB = { surface: "web", conversationId: "tab-1" };
    let releaseChild!: () => void;
    const childGate = new Promise<void>((r) => (releaseChild = r));
    respond = async (b) => {
      if (isChild(b)) {
        await childGate;
        return { text: "bg finding: 7" };
      }
      const last = lastMessage(b);
      if (last.includes("dig in the DM")) return { tool: { name: "delegate", args: { agent: "explore", task: "dig", background: true } } };
      if (last.includes("bg finding: 7")) return { text: "result: 7" };
      return { text: last.includes("web question") ? "web answer" : "started" };
    };
    await h.personal.handleMessage(user("m1", "dig in the DM"));
    await until(() => h.delivered.length === 1);
    await h.personal.handleMessage({ ...user("m2", "web question"), origin: WEB });
    await until(() => h.delivered.length === 2);
    expect(h.delivered[1]).toMatchObject({ text: "web answer", origin: WEB });
    const pending = new PendingResults(h.cfg.stateDir);
    expect(pending.list()).toHaveLength(0);

    releaseChild();
    await until(() => h.delivered.length === 3);
    expect(h.delivered[2]).toMatchObject({ text: "result: 7", origin: { surface: "discord", conversationId: "dm" } });
    expect(h.delivered[2].replyTo).toBeUndefined();
    expect(new PendingResults(h.cfg.stateDir).list()).toHaveLength(0);
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

  async function direct(limits: Partial<SubagentLimits>, extra: Partial<SubagentHostOptions> = {}) {
    const cfg = config();
    await scaffoldHome(cfg.home);
    const runs = new RunLog(cfg.stateDir);
    const host = new SubagentHost({ config: cfg, runs, selector: new BackendSelector({ primaryEnabled: false }), limits, ...extra });
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

  test("token cap counts cache reads", async () => {
    const { host, call } = await direct({ maxTokens: 500 });
    respond = () => ({ tool: { name: "ls", args: { path: "." } }, usage: { prompt_tokens: 1000, completion_tokens: 3, total_tokens: 1003, prompt_tokens_details: { cached_tokens: 990 } } });
    const out = await call("cached");
    expect(out.status).toBe("aborted");
    expect(out.text).toContain("token cap");
    await host.dispose();
  }, 30_000);

  test("cost cap prices the child's tokens and aborts past it", async () => {
    const priced: string[] = [];
    const { host, call, runs } = await direct(
      { maxCostUsd: 0.01 },
      {
        priceOf: async (id) => {
          priced.push(id);
          return { input: 1000, output: 1000, cacheRead: 100, cacheWrite: 1000 };
        },
      },
    );
    respond = () => ({ tool: { name: "ls", args: { path: "." } } });
    const out = await call("pricey");
    expect(priced).toEqual(["openai/gpt-6-luna"]);
    expect(out.status).toBe("aborted");
    expect(out.text).toContain("cost cap");
    expect(runs.getRun(out.runId)?.usage?.costUsd).toBeGreaterThan(0.01);
    await host.dispose();
  }, 30_000);

  test("two continues of one run in the same message: the second is refused", async () => {
    const { host, call } = await direct({});
    respond = () => ({ text: "first" });
    const first = await call("start");
    respond = () => new Promise<Reply>((r) => setTimeout(() => r({ text: "again" }), 100));
    const results = await Promise.allSettled([call("a", { continue: first.runId }), call("b", { continue: first.runId })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("in use");
    await host.dispose();
  }, 30_000);

  test("a foreground child queued for a slot is bounded by its wall clock", async () => {
    const { host, call, runs } = await direct({ maxReaders: 1, foregroundTimeoutMs: 300 });
    respond = () => new Promise<Reply>(() => {});
    // Background, so its own (longer) wall clock keeps the slot held past the second call's.
    await call("holds the slot", { background: true });
    await until(() => bodies.length === 1);
    const started = Date.now();
    const second = await call("waits");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(second.status).toBe("timeout");
    expect(second.text).toContain("wall-clock cap");
    expect(runs.getRun(second.runId)?.status).toBe("timeout");
    expect(bodies).toHaveLength(1);
    await host.dispose();
  }, 30_000);

  test("at most maxWriters writers run at once", async () => {
    const { cfg, host, call } = await direct({ maxWriters: 1 });
    await initRepo(cfg.home, "repo");
    const gates: Array<() => void> = [];
    respond = async () => {
      await new Promise<void>((r) => gates.push(r));
      return { text: "coded" };
    };
    const a = call("one", { agent: "coder", repo: "repo", background: false });
    const b = call("two", { agent: "coder", repo: "repo", background: false });
    await until(() => gates.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(gates).toHaveLength(1);
    gates.shift()!();
    await until(() => gates.length === 1);
    gates.shift()!();
    expect((await Promise.all([a, b])).map((r) => r.status)).toEqual(["done", "done"]);
    await host.dispose();
  }, 30_000);

  test("creating a queued writer's worktree does not trip the active writer's guard", async () => {
    const { cfg, host, call } = await direct({ maxWriters: 1 });
    await initRepo(cfg.home, "repo");
    const hold = join(root, "hold-checkout");
    const ready = join(root, "checkout-ready");
    const release = join(root, "release-checkout");
    const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(cfg.home, "projects/repo/.git/hooks/post-checkout"),
      `#!/bin/sh\nif [ -f ${quote(hold)} ]; then\n  touch ${quote(ready)}\n  while [ ! -f ${quote(release)} ]; do sleep 0.01; done\nfi\n`, { mode: 0o755 });
    const gates: Array<() => void> = [];
    respond = async () => {
      await new Promise<void>((r) => gates.push(r));
      return { text: "coded" };
    };
    const a = call("one", { agent: "coder", repo: "repo", background: false });
    await until(() => gates.length === 1);
    // Finish the first writer while Git still holds the second worktree's lock.
    writeFileSync(hold, "");
    const b = call("two", { agent: "coder", repo: "repo", background: false });
    await until(() => existsSync(ready));
    expect(gates).toHaveLength(1);
    gates.shift()!();
    const first = await a;
    writeFileSync(release, "");
    await until(() => gates.length === 1);
    gates.shift()!();
    expect([first.status, (await b).status]).toEqual(["done", "done"]);
    await host.dispose();
  }, 30_000);

  test("pending background results are redelivered by a fresh host after a restart until consumed", async () => {
    const cfg = config();
    await scaffoldHome(cfg.home);
    new PendingResults(cfg.stateDir).add({ runId: "01OLD", agent: "explore", status: "done", text: "<subagent-result>x</subagent-result>", createdAt: "2026-09-29T00:00:00Z" });
    const woken: string[] = [];
    let consume: (() => void) | null = null;
    const host = new SubagentHost({
      config: cfg,
      runs: new RunLog(cfg.stateDir),
      selector: new BackendSelector({ primaryEnabled: false }),
      wake: (r, consumed) => {
        woken.push(r.runId);
        consume = consumed;
      },
    });
    host.redeliverPending();
    expect(woken).toEqual(["01OLD"]);
    expect(new PendingResults(cfg.stateDir).list()).toHaveLength(1);
    consume!();
    expect(new PendingResults(cfg.stateDir).list()).toHaveLength(0);
    await host.dispose();
  });
});

async function initRepo(home: string, name: string): Promise<void> {
  const dir = join(home, "projects", name);
  mkdirSync(dir, { recursive: true });
  const g = runnerGit(dir);
  await g.init();
  await g.addConfig("user.name", "t").addConfig("user.email", "t@t").addConfig("commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a\n");
  await g.add(".").commit("init");
}
