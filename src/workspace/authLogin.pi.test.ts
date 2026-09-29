import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AuthLogin, LOGIN_INSTRUCTIONS, piChatGptLogin, type OutOfBandDelivery } from "./authLogin.ts";
import { BackendSelector } from "./chatgptFallback.ts";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory } from "./piChatSession.ts";

// Real Pi 0.99.1: its ChatGPT OAuth login, its auth.json store and a real chat session. Only fetch is faked.
const OPENROUTER_BASE = "http://openrouter.test/v1";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const USAGE_LIMIT_BODY = { error: { code: "subscription_sharing_usage_limit_exceeded", type: "usage_limit_reached", message: "usage limit reached" } };

let root: string;
let requests: string[];
let tokenGrants: Array<Record<string, string>>;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

const isChatGpt = (url: string) => url.startsWith("https://api.openai.com/");
const isOpenRouter = (url: string) => url.startsWith(`${OPENROUTER_BASE}/chat/completions`);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function openRouterReply(text: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-6-luna", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const body = chunk({ role: "assistant", content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Token endpoint: the authorization_code grant succeeds; refresh grants fail as a revoked refresh token would. */
function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (url === TOKEN_URL) {
      const grant = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      tokenGrants.push(grant);
      if (grant.grant_type !== "authorization_code") return jsonResponse(400, { error: "invalid_grant" });
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: "id-token",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        expires_in: 3600,
      });
    }
    if (isChatGpt(url)) return jsonResponse(429, USAGE_LIMIT_BODY);
    if (isOpenRouter(url)) return openRouterReply("from openrouter");
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-auth-pi-"));
  requests = [];
  tokenGrants = [];
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  stubFetch();
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
    chatgptModel: "gpt-6.1-sol",
    model: "openai/gpt-6-luna",
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
}

async function run(session: AgentSession, text: string): Promise<void> {
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "agent_settled") settled();
  });
  await session.prompt(text);
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("no agent_settled within 5s")), 5000))]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  unsubscribe();
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function harness() {
  const authFailures: number[] = [];
  const selector = new BackendSelector({ primaryEnabled: true, onAuthFailure: () => authFailures.push(Date.now()) });
  const delivered: OutOfBandDelivery[] = [];
  const login = new AuthLogin({
    principalId: "drk",
    login: piChatGptLogin({ agentDir: config().agentDir, cwd: config().home }),
    deliver: (d) => delivered.push(d),
    model: "gpt-6.1-sol",
    onLoggedIn: () => selector.reset(),
    log: { info: () => {}, warn: () => {} },
  });
  return { selector, authFailures, delivered, login, factory: createPiChatSessionFactory(config(), { selector }) };
}

/** Logs in through Pi's real flow, pasting a callback URL built from the delivered authorize URL. */
async function loginViaPaste(h: ReturnType<typeof harness>, host = "127.0.0.1") {
  h.login.start({ surface: "discord", conversationId: "dm" });
  await waitFor(() => h.delivered.some((d) => d.kind === "auth"), "the auth delivery");
  const auth = h.delivered.find((d) => d.kind === "auth")!;
  const authorize = new URL(auth.auth!.url);
  const state = authorize.searchParams.get("state")!;
  const callback = `http://${host}:1455/auth/callback?code=the-code&state=${encodeURIComponent(state)}&client_id=issued-client`;
  const result = await h.login.complete(callback);
  return { auth, authorize, result };
}

describe("ChatGPT login from a chat surface, on real Pi", () => {
  test("stores the credential via Pi's store with Pi's device id, and the next turn runs on ChatGPT", async () => {
    writeFileSync(join(root, "agent", "auth.json"), "{}");
    const h = harness();
    const { session } = await h.factory({ sessionFile: null });
    const s = session as AgentSession;
    expect(s.model?.provider).toBe("sushii-workspace-openrouter");
    await run(s, "before login");
    expect(requests.filter(isChatGpt)).toHaveLength(0);

    const { auth, authorize, result } = await loginViaPaste(h, "localhost");
    expect(result).toEqual({ ok: true, model: "gpt-6.1-sol" });
    expect(auth.auth!.instructions).toBe(LOGIN_INSTRUCTIONS);
    expect(auth.origin).toEqual({ surface: "discord", conversationId: "dm" });

    const deviceId = JSON.parse(readFileSync(join(root, "agent", "settings.json"), "utf8")).deviceId as string;
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(authorize.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${deviceId}`);
    expect(tokenGrants).toEqual([expect.objectContaining({ grant_type: "authorization_code", code: "the-code", client_id: "issued-client" })]);
    const stored = JSON.parse(readFileSync(join(root, "agent", "auth.json"), "utf8")).openai;
    expect(stored).toMatchObject({ type: "oauth", access: "new-access", refresh: "new-refresh", clientId: "issued-client" });
    expect(h.delivered.at(-1)).toMatchObject({ kind: "reply", authResult: "ok", text: "✅ ChatGPT connected · gpt-6.1-sol" });

    // Same live session, no restart: the next turn starts on ChatGPT (its 429 then falls back as usual).
    await run(s, "after login");
    expect(requests.filter(isChatGpt)).toHaveLength(1);
    expect(h.authFailures).toHaveLength(0);
    s.dispose();
  });

  test("a revoked refresh token cools down onto OpenRouter; a login ends the cool-down for the next turn", async () => {
    writeFileSync(
      join(root, "agent", "auth.json"),
      JSON.stringify({ openai: { type: "oauth", access: "old", refresh: "revoked", expires: Date.now() - 1000, clientId: "old-client", scopes: ["chatgpt.tokens.use.direct"] } }),
    );
    const h = harness();
    const { session } = await h.factory({ sessionFile: null });
    const s = session as AgentSession;
    expect(s.model?.provider).toBe("sushii-workspace-openrouter");
    expect(h.authFailures.length).toBeGreaterThanOrEqual(1);
    expect(h.selector.coolingDownUntil).not.toBeNull();

    const { result } = await loginViaPaste(h);
    expect(result.ok).toBe(true);
    expect(h.selector.coolingDownUntil).toBeNull();

    const failuresBefore = h.authFailures.length;
    await run(s, "after login");
    expect(requests.filter(isChatGpt)).toHaveLength(1);
    expect(h.authFailures).toHaveLength(failuresBefore);
    s.dispose();
  });

  test("reuses the device id Pi already stores, and a busy callback port is harmless", async () => {
    writeFileSync(join(root, "agent", "auth.json"), "{}");
    const deviceId = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ deviceId }));
    const squatter = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      squatter.once("error", () => resolve(false));
      squatter.listen(1455, "127.0.0.1", () => resolve(true));
    });
    try {
      const h = harness();
      const { authorize, result } = await loginViaPaste(h);
      expect(result).toEqual({ ok: true, model: "gpt-6.1-sol" });
      expect(authorize.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${deviceId}`);
      expect(JSON.parse(readFileSync(join(root, "agent", "settings.json"), "utf8")).deviceId).toBe(deviceId);
      expect(bound).toBe(true);
    } finally {
      if (bound) await new Promise((r) => squatter.close(r));
    }
  });

  test("the authorize URL is longer than a Discord link button allows", async () => {
    writeFileSync(join(root, "agent", "auth.json"), "{}");
    const h = harness();
    h.login.start({ surface: "discord", conversationId: "dm" });
    await waitFor(() => h.delivered.some((d) => d.kind === "auth"), "the auth delivery");
    const url = h.delivered.find((d) => d.kind === "auth")!.auth!.url;
    // Discord caps a link button's url at 512 chars, so the adapter falls back to a masked link.
    expect(url.length).toBeGreaterThan(512);
    await h.login.cancel();
    expect(h.delivered.at(-1)).toMatchObject({ kind: "reply", authResult: "cancelled" });
  });
});
