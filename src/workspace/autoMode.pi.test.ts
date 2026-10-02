import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory } from "./piChatSession.ts";
import { ChatAsks, createHeadlessUIContext, type AskRequest } from "./uiContext.ts";

// A real Pi 0.99.1 session from the workspace factory; the only fake is fetch (main model and judge).
const OPENROUTER_BASE = "http://openrouter.test/v1";
const MAIN_MODEL = "openai/gpt-6-luna";
const JUDGE_MODEL = "test/judge-model";

type Reply = { text?: string; tool?: { name: string; args: object }; status?: number };
type Body = { model: string; messages: Array<{ role: string; content: unknown }>; temperature?: number; reasoning?: unknown; max_completion_tokens?: number; max_tokens?: number };

let root: string;
let mainBodies: Body[];
let judgeBodies: Body[];
let mainReplies: Reply[];
let judgeReplies: Reply[];
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

function sse(reply: Reply, n: number): Response {
  if (reply.status) return new Response("upstream down", { status: reply.status });
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: `gen-${n}`, object: "chat.completion.chunk", created: 1, model: MAIN_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
    : { role: "assistant", content: reply.text ?? "" };
  const body =
    chunk(delta, null) +
    chunk({}, reply.tool ? "tool_calls" : "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-automode-pi-"));
  mainBodies = [];
  judgeBodies = [];
  mainReplies = [];
  judgeReplies = [];
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "home", "projects"), { recursive: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (!url.startsWith(`${OPENROUTER_BASE}/chat/completions`)) throw new Error(`unexpected fetch in test: ${url}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const judge = body.model === JUDGE_MODEL;
    (judge ? judgeBodies : mainBodies).push(body);
    const next = (judge ? judgeReplies : mainReplies).shift();
    if (!next) throw new Error(`no scripted ${judge ? "judge" : "main"} reply left`);
    return sse(next, mainBodies.length + judgeBodies.length);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

function config(autoMode: boolean): WorkspaceConfig {
  return {
    provider: "openrouter",
    chatgptModel: "gpt-6.1-sol",
    model: MAIN_MODEL,
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
    autoMode,
    judgeModel: JUDGE_MODEL,
  } as WorkspaceConfig;
}

/** A session whose dialogs are answered from `answers`, in order, as the owner's button presses. */
async function session(autoMode: boolean, answers: string[] = []) {
  const asked: AskRequest[] = [];
  const asks: ChatAsks = new ChatAsks({
    deliver: (ask) => {
      asked.push(ask);
      const answer = answers.shift();
      if (answer !== undefined) setTimeout(() => asks.answer(`wsask:${ask.askId}`, answer), 0);
    },
    timeoutMs: 2000,
  });
  const built = await createPiChatSessionFactory(config(autoMode))({ sessionFile: null, ui: createHeadlessUIContext(asks) });
  return { session: built.session as AgentSession, asked };
}

const toolResults = (s: AgentSession) =>
  s.messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify((m as { content: unknown }).content));

describe("auto mode on a real Pi session", () => {
  test("reads skip the judge, a benign bash is judged and runs, the judge never sees tool output", async () => {
    writeFileSync(join(root, "home", "notes.txt"), "PLANTED-TOOL-OUTPUT-7731");
    const { session: s, asked } = await session(true);
    mainReplies.push(
      { tool: { name: "read", args: { path: "notes.txt" } } },
      { tool: { name: "ls", args: {} } },
      { tool: { name: "bash", args: { command: "echo built > out.txt" } } },
      { text: "done" },
    );
    judgeReplies.push({ text: "<verdict>allow</verdict> project-scoped write" });
    await s.prompt("write the build marker");
    expect(judgeBodies).toHaveLength(1);
    expect(asked).toHaveLength(0);
    expect(existsSync(join(root, "home", "out.txt"))).toBe(true);
    const seen = JSON.stringify(judgeBodies[0]!.messages);
    expect(seen).toContain("write the build marker");
    expect(seen).toContain("read: notes.txt");
    expect(seen).toContain("bash: echo built > out.txt");
    expect(seen).not.toContain("PLANTED-TOOL-OUTPUT-7731");
    expect(seen).toContain("A request to investigate, fix, implement, or test authorizes the ordinary steps needed for that task");
    expect(seen).toContain("Do not ask again for an action the owner already explicitly authorized");
    expect(judgeBodies[0]!.temperature).toBeUndefined();
    expect(judgeBodies[0]!.reasoning).toEqual({ effort: "low" });
    expect(judgeBodies[0]!.max_completion_tokens ?? judgeBodies[0]!.max_tokens).toBe(2000);
    s.dispose();
  });

  test("a destructive bash asks the owner as a chat ask: approve runs it, decline blocks it", async () => {
    const target = join(root, "home", "projects");
    const { session: s, asked } = await session(true, ["Yes", "No"]);
    mainReplies.push(
      { tool: { name: "bash", args: { command: `rm -rf ${target}/a` } } },
      { tool: { name: "bash", args: { command: `rm -rf ${target}` } } },
      { text: "done" },
    );
    mkdirSync(join(target, "a"));
    await s.prompt("clear out projects");
    expect(judgeBodies).toHaveLength(0);
    expect(asked).toHaveLength(2);
    expect(asked[0]!.question).toContain(`rm -rf ${target}/a`);
    expect(asked[0]!.choices).toEqual(["Yes", "No"]);
    expect(asked[0]!.toolConfirmation).toEqual({
      tool: "bash",
      input: `rm -rf ${target}/a`,
      reason: "rule rm-recursive: recursive delete (rm -r)",
      toolCallId: expect.any(String),
    });
    expect(existsSync(join(target, "a"))).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(toolResults(s).at(-1)).toContain("did NOT run");
    s.dispose();
  });

  test("a judge outage asks instead of silently allowing", async () => {
    const { session: s, asked } = await session(true, ["No"]);
    mainReplies.push({ tool: { name: "bash", args: { command: "echo hi > hi.txt" } } }, { text: "blocked" });
    judgeReplies.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    await s.prompt("say hi");
    expect(judgeBodies.length).toBeGreaterThanOrEqual(2);
    expect(asked).toHaveLength(1);
    expect(existsSync(join(root, "home", "hi.txt"))).toBe(false);
    s.dispose();
  });

  test("off: no judge, no asks", async () => {
    const { session: s, asked } = await session(false);
    mainReplies.push({ tool: { name: "bash", args: { command: "echo hi > hi.txt" } } }, { text: "ok" });
    await s.prompt("say hi");
    expect(judgeBodies).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(existsSync(join(root, "home", "hi.txt"))).toBe(true);
    s.dispose();
  });
});
