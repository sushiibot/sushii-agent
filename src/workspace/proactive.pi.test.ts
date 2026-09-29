import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS, type ToolCallParams, type ToolManifestEntry } from "../orchestration/contracts.ts";
import type { WorkspaceConfig } from "./config.ts";
import { ProactiveLimiter, createHeartbeatJob } from "./proactive.ts";
import { RunLog } from "./runLog.ts";
import { jobSessionDir } from "./sessionPaths.ts";
import { ToolStubs } from "./toolStubs.ts";

// Real Pi 0.99.1 job sessions; the only fake is fetch.
const BASE = "http://openrouter.test/v1";
const AGENTS_MARKER = "AGENTS-MD-REACHES-THE-JOB";
const USER_MARKER = "USER-MD-REACHES-THE-JOB";
const MEMORY = "# MEMORY.md\n\n- Deploys from main. (src: 2026-09-10)\n";
const AUTH_SECRET = "refresh-token-must-not-leak";

type Reply = { text?: string; tool?: { name: string; args: object } };
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };

let root: string;
let bodies: Body[];
let script: Reply[];
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

const toolNames = (b: Body) => (b.tools ?? []).map((t) => t.function.name).sort();

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
    tz: "UTC",
    consolidateAt: "04:00",
    heartbeat: { when: { kind: "every", minutes: 120 } },
    proactiveDailyCap: 6,
  } as WorkspaceConfig;
}

const SEARCH: ToolManifestEntry = {
  name: "web_search",
  description: "Search the web.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  approval: "none",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-proactive-pi-"));
  bodies = [];
  script = [];
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "auth.json"), JSON.stringify({ openrouter: { key: AUTH_SECRET } }));
  const home = join(root, "home");
  mkdirSync(join(home, "memory"), { recursive: true });
  writeFileSync(join(home, "AGENTS.md"), `# AGENTS\n${AGENTS_MARKER}\n`);
  writeFileSync(join(home, "USER.md"), `# USER\n${USER_MARKER}\n`);
  writeFileSync(join(home, "MEMORY.md"), MEMORY);
  writeFileSync(join(home, "memory", "2026-09-29.md"), "- drk is waiting on a deploy\n");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (!url.startsWith(`${BASE}/chat/completions`)) throw new Error(`unexpected fetch in test: ${url}`);
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
    return sse(script[bodies.length - 1] ?? { text: "NO_REPLY" }, bodies.length);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

describe("heartbeat on a real Pi session", () => {
  test("read-only tools only: no bash, no memory writes, no credential reads; stubs run as job:heartbeat; logged and delivered", async () => {
    const cfg = config();
    const runs = new RunLog(cfg.stateDir);
    const toolCalls: ToolCallParams[] = [];
    const toolStubs = new ToolStubs({
      principalId: "drk",
      request: async (method, params) => {
        if (method === RPC_METHODS.toolCall) toolCalls.push(params as ToolCallParams);
        return { ok: true, result: "search hits" };
      },
    });
    toolStubs.update([SEARCH]);
    const delivered: string[] = [];
    const notes: string[] = [];
    script = [
      { tool: { name: "write", args: { path: "MEMORY.md", content: "overwritten" } } },
      { tool: { name: "edit", args: { path: "MEMORY.md", edits: [{ oldText: "Deploys", newText: "Ships" }] } } },
      { tool: { name: "bash", args: { command: "echo pwned >> MEMORY.md" } } },
      { tool: { name: "read", args: { path: join(root, "agent", "auth.json") } } },
      { tool: { name: "web_search", args: { query: "deploy status" } } },
      { text: "The deploy drk is waiting on has failed." },
    ];

    const outcome = await createHeartbeatJob(cfg.heartbeat!, {
      config: cfg,
      runs,
      toolStubs,
      limiter: new ProactiveLimiter(cfg.stateDir, cfg.proactiveDailyCap),
      deliver: (t) => delivered.push(t),
      note: async (_name, t) => {
        notes.push(t);
      },
    }).run({ trigger: "interval", force: false });

    expect(outcome.status).toBe("sent");
    expect(bodies).toHaveLength(6);
    for (const b of bodies) expect(toolNames(b)).toEqual(["find", "grep", "ls", "read", "web_search"]);
    expect(readFileSync(join(cfg.home, "MEMORY.md"), "utf8")).toBe(MEMORY);
    expect(JSON.stringify(bodies.at(-1)!.messages)).not.toContain(AUTH_SECRET);
    const results = bodies.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
    expect(results.slice(0, 3)).toEqual(['"Tool write not found"', '"Tool edit not found"', '"Tool bash not found"']);
    expect(results[3]).toContain("Blocked by the secret guard");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "web_search", agentId: "job:heartbeat", agentName: "job:heartbeat" });

    const system = String(bodies[0]!.messages[0]!.content);
    expect(system).toContain('scheduled job "heartbeat"');
    expect(system).toContain(AGENTS_MARKER);
    expect(system).toContain(USER_MARKER);
    expect(JSON.stringify(bodies[0])).not.toContain("Deploys from main");
    expect(JSON.stringify(bodies[0]!.messages.at(-1))).toContain("drk is waiting on a deploy");

    expect(delivered).toEqual(["The deploy drk is waiting on has failed."]);
    expect(notes).toHaveLength(1);
    const [run] = runs.listRuns({ agentName: "job:heartbeat" });
    expect(run).toMatchObject({ agentName: "job:heartbeat", status: "done" });
    expect(run!.sessionFile.startsWith(`${jobSessionDir(cfg.agentDir)}/`)).toBe(true);
    expect(existsSync(run!.sessionFile)).toBe(true);
    // The job's stub binding is released with its session.
    expect((toolStubs as unknown as { bindings: Set<unknown> }).bindings.size).toBe(0);
  });

  test("NO_REPLY on a real session: nothing delivered, run still logged", async () => {
    const cfg = config();
    const runs = new RunLog(cfg.stateDir);
    const delivered: string[] = [];
    script = [{ text: "NO_REPLY" }];
    const outcome = await createHeartbeatJob(cfg.heartbeat!, {
      config: cfg,
      runs,
      limiter: new ProactiveLimiter(cfg.stateDir, cfg.proactiveDailyCap),
      deliver: (t) => delivered.push(t),
      note: async () => {},
    }).run({ trigger: "interval", force: false });
    expect(outcome).toEqual({ status: "no_reply" });
    expect(delivered).toEqual([]);
    expect(toolNames(bodies[0]!)).toEqual(["find", "grep", "ls", "read"]);
    expect(runs.listRuns({ agentName: "job:heartbeat" })[0]).toMatchObject({ status: "done" });
  });
});
