import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory } from "./piChatSession.ts";
import { verifyFollowUp } from "./verifyGate.ts";
import { LOOP_NUDGE, repeatReason } from "./loopGuard.ts";

// A real Pi 0.99.1 session from the workspace factory; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";

let root: string;
let bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

type Reply = { text: string } | { tool: string; args: object };

function sse(reply: Reply): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-6-luna", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const usage = { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };
  const body =
    "text" in reply
      ? chunk({ role: "assistant", content: reply.text }, null) + chunk({}, "stop", usage)
      : chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, null) +
        chunk({}, "tool_calls", usage);
  return new Response(`${body}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubReplies(replies: Reply[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (!url.startsWith(`${OPENROUTER_BASE}/chat/completions`)) throw new Error(`unexpected fetch in test: ${url}`);
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const reply = replies[bodies.length - 1];
    if (!reply) throw new Error(`unexpected model request #${bodies.length}`);
    return sse(reply);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-verify-pi-"));
  bodies = [];
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "home", "projects", "app"), { recursive: true });
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
    model: "openai/gpt-6-luna",
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
}

async function run(session: AgentSession, text: string): Promise<AgentSessionEvent[]> {
  const events: AgentSessionEvent[] = [];
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
    if (event.type === "agent_settled") settled();
  });
  await session.prompt(text);
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("no agent_settled within 5s")), 5000))]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  unsubscribe();
  return events;
}

describe("verify gate on a real Pi session", () => {
  test("a code change without a check gets one follow-up inside the same run", async () => {
    stubReplies([{ tool: "write", args: { path: "projects/app/a.ts", content: "export const a = 1;\n" } }, { text: "done" }, { text: "done, no check" }]);
    const { session } = await createPiChatSessionFactory(config())({ sessionFile: null });

    const events = await run(session as AgentSession, "add a.ts");

    expect(existsSync(join(root, "home", "projects", "app", "a.ts"))).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[2].messages.at(-1))).toContain(verifyFollowUp(["app"]));
    expect(JSON.stringify(bodies[1].messages)).not.toContain("Before finishing");
    expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
    session.dispose();
  });
});

describe("guard order on a real Pi session", () => {
  const readSecret = () => ({ tool: "read", args: { path: join(root, "agent", "auth.json") } });

  test("the loop guard counts calls another guard blocks, so a repeated blocked call gets its repeat reason", async () => {
    stubReplies([readSecret(), readSecret(), readSecret(), { text: "stopped" }]);
    const { session } = await createPiChatSessionFactory(config())({ sessionFile: null });

    await run(session as AgentSession, "show me the auth file");

    expect(bodies).toHaveLength(4);
    expect(JSON.stringify(bodies[3].messages.at(-1))).toContain(repeatReason(2));
    session.dispose();
  });

  test("once the loop guard tells the agent to stop, the verify gate doesn't ask for a check", async () => {
    const readMissing = { tool: "read", args: { path: "missing.txt" } };
    stubReplies([
      { tool: "write", args: { path: "projects/app/a.ts", content: "export const a = 1;\n" } },
      readMissing,
      readMissing,
      readMissing,
      readMissing,
      { text: "I kept failing to read missing.txt." },
    ]);
    const { session } = await createPiChatSessionFactory(config())({ sessionFile: null });

    await run(session as AgentSession, "add a.ts");

    expect(JSON.stringify(bodies.at(-1)!.messages)).toContain(LOOP_NUDGE);
    expect(bodies).toHaveLength(6);
    session.dispose();
  });

  test("auto mode's rule layer allows an in-home memory write: no judge call, no ask", async () => {
    stubReplies([{ tool: "write", args: { path: "MEMORY.md", content: "# Memory\n- likes tea\n" } }, { text: "noted" }]);
    const { session } = await createPiChatSessionFactory({ ...config(), autoMode: true, judgeModel: "test/judge" })({ sessionFile: null });

    await run(session as AgentSession, "remember I like tea");

    expect(readFileSync(join(root, "home", "MEMORY.md"), "utf8")).toContain("likes tea");
    expect(bodies).toHaveLength(2);
    session.dispose();
  });
});
