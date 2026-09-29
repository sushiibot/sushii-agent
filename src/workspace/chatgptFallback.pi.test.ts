import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory, reloadContext } from "./piChatSession.ts";

// Real Pi 0.99.1 sessions from the workspace factory; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";
const CHATGPT_MODEL = "gpt-6.1-sol";
const USAGE_LIMIT_BODY = { error: { code: "subscription_sharing_usage_limit_exceeded", type: "usage_limit_reached", message: "usage limit reached" } };

let root: string;
let requests: string[];
let openRouterBodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

type Handler = (url: string) => Response | undefined;

function stubFetch(handler: Handler): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (isOpenRouter(url)) openRouterBodies.push(JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}"))));
    // The OpenRouter model catalog lookup falls back to a default context window.
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    const response = handler(url);
    if (!response) throw new Error(`unexpected fetch in test: ${url}`);
    return response;
  }) as unknown as typeof fetch;
}

const isChatGpt = (url: string) => url.startsWith("https://api.openai.com/");
const isOpenRouter = (url: string) => url.startsWith(`${OPENROUTER_BASE}/chat/completions`);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function openRouterReply(text: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-6-luna", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-fallback-pi-"));
  requests = [];
  openRouterBodies = [];
  // Production deletes the OpenRouter key from the env so Pi's openai provider can't pick it up.
  delete process.env.OPENAI_API_KEY;
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
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
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

function config(): WorkspaceConfig {
  return {
    provider: "chatgpt",
    chatgptModel: CHATGPT_MODEL,
    model: "openai/gpt-6-luna",
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
}

async function newSession(): Promise<AgentSession> {
  const { session } = await createPiChatSessionFactory(config())({ sessionFile: null });
  return session as AgentSession;
}

/** Runs one prompt to its settle and returns the events seen. */
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
  // Anything a second run would emit arrives after the settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  unsubscribe();
  return events;
}

type Msg = { role: string; provider?: string; stopReason?: string; errorMessage?: string; content?: unknown };

function contextMessages(session: AgentSession): Msg[] {
  return session.messages as unknown as Msg[];
}

function assistantEnds(events: AgentSessionEvent[]): Msg[] {
  return events.flatMap((e) => (e.type === "message_end" && (e.message as Msg).role === "assistant" ? [e.message as Msg] : []));
}

describe("ChatGPT → OpenRouter fallback on a real Pi session", () => {
  test("a usage-limit 429 retries the turn once on OpenRouter and settles once with one reply", async () => {
    stubFetch((url) => (isChatGpt(url) ? jsonResponse(429, USAGE_LIMIT_BODY) : isOpenRouter(url) ? openRouterReply("from openrouter") : undefined));
    const session = await newSession();
    expect(session.model?.provider).toBe("openai");

    const events = await run(session, "hello");

    expect(requests.filter(isChatGpt)).toHaveLength(1);
    expect(requests.filter(isOpenRouter)).toHaveLength(1);
    expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
    const ends = assistantEnds(events);
    expect(ends.map((m) => [m.provider, m.stopReason])).toEqual([
      ["openai", "error"],
      ["sushii-workspace-openrouter", "stop"],
    ]);

    // The failed ChatGPT attempt is hidden from the transcript context and from what OpenRouter is sent.
    const context = contextMessages(session).filter((m) => m.role === "user" || m.role === "assistant");
    expect(context.map((m) => [m.role, m.provider, m.stopReason])).toEqual([
      ["user", undefined, undefined],
      ["assistant", "sushii-workspace-openrouter", "stop"],
    ]);
    expect(JSON.stringify(context[1].content)).toContain("from openrouter");
    expect(openRouterBodies[0].messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(session.model?.provider).toBe("sushii-workspace-openrouter");

    // The next turn stays on OpenRouter for the cool-down, and its context carries only the good reply.
    await run(session, "again");
    expect(requests.filter(isChatGpt)).toHaveLength(1);
    expect(requests.filter(isOpenRouter)).toHaveLength(2);
    expect(openRouterBodies[1].messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(JSON.stringify(openRouterBodies[1].messages[2].content)).toContain("from openrouter");
    session.dispose();
  });

  test("when OpenRouter fails too, the turn ends in one error settle without looping", async () => {
    stubFetch((url) =>
      isChatGpt(url)
        ? jsonResponse(429, USAGE_LIMIT_BODY)
        : isOpenRouter(url)
          ? jsonResponse(400, { error: { message: "bad request", code: 400 } })
          : undefined,
    );
    const session = await newSession();

    const events = await run(session, "hello");

    expect(requests.filter(isChatGpt)).toHaveLength(1);
    expect(requests.filter(isOpenRouter)).toHaveLength(1);
    expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
    expect(assistantEnds(events).map((m) => [m.provider, m.stopReason])).toEqual([
      ["openai", "error"],
      ["sushii-workspace-openrouter", "error"],
    ]);
    session.dispose();
  });
});

describe("cache warming", () => {
  test("is off for the workspace session even when global settings turn it on, and stays off after a reload", async () => {
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ cacheWarming: "streaming" }));
    stubFetch(() => undefined);
    const session = await newSession();
    expect(session.settingsManager.getCacheWarmingMode()).toBe("off");
    await reloadContext(session);
    expect(session.settingsManager.getCacheWarmingMode()).toBe("off");
    session.dispose();
  });
});
