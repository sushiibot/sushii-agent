import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_METHODS, LOGIN_ALREADY_PENDING } from "../orchestration/contracts.ts";
import { Outbox, redactAuthUrl } from "./outbox.ts";
import { AuthLogin, LOGIN_INSTRUCTIONS, publicLoginError, refuseIfCallbackServerListens, REAUTH_NOTICE, REAUTH_NOTICE_INTERVAL_MS, ReauthNotifier, type LoginFn, type OutOfBandDelivery } from "./authLogin.ts";

const ORIGIN = { surface: "discord", conversationId: "dm" };
const PASTE = "http://127.0.0.1:1455/auth/callback?code=SECRET-CODE&state=s1&client_id=c1";

type Interaction = Parameters<LoginFn>[0];

/** Pi's login shape: notify auth_url, wait on a manual_code prompt, then validate the pasted URL. */
function fakePiLogin(record: { inputs: string[] }, opts: { fail?: string | ((input: string) => string) } = {}): LoginFn {
  return async (interaction: Interaction) => {
    await Promise.resolve();
    interaction.notify({ type: "info", message: "Could not listen on http://127.0.0.1:1455/auth/callback" });
    interaction.notify({ type: "auth_url", url: "https://auth.openai.com/api/accounts/authorize?state=s1", instructions: "pi's own text" });
    let input: string;
    try {
      input = await interaction.prompt({ type: "manual_code", message: "paste", signal: interaction.signal });
    } catch (err) {
      if (interaction.signal?.aborted) throw new Error("Login cancelled");
      throw err;
    }
    record.inputs.push(input);
    const url = new URL(input);
    if (url.origin !== "http://127.0.0.1:1455") throw new Error("The pasted callback URL must start with http://127.0.0.1:1455/auth/callback");
    if (url.searchParams.get("state") !== "s1") throw new Error("OAuth state mismatch");
    if (opts.fail) throw new Error(typeof opts.fail === "string" ? opts.fail : opts.fail(input));
  };
}

function setup(opts: { fail?: string | ((input: string) => string); timeoutMs?: number } = {}) {
  const record = { inputs: [] as string[] };
  const delivered: OutOfBandDelivery[] = [];
  const logs: Array<{ level: string; obj: object; msg: string }> = [];
  let loggedIn = 0;
  const auth = new AuthLogin({
    principalId: "drk",
    login: fakePiLogin(record, opts),
    deliver: (d) => delivered.push(d),
    model: "gpt-6.1-sol",
    onLoggedIn: () => loggedIn++,
    timeoutMs: opts.timeoutMs,
    log: { info: (obj, msg) => logs.push({ level: "info", obj, msg }), warn: (obj, msg) => logs.push({ level: "warn", obj, msg }) },
  });
  return { auth, record, delivered, logs, loggedIn: () => loggedIn };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AuthLogin", () => {
  test("start delivers the sign-in link to the origin; the paste completes it and the result is delivered", async () => {
    const t = setup();
    const started = (await t.auth.handlers()[AUTH_METHODS.start]!({ principalId: "drk", provider: "openai", origin: ORIGIN })) as { started: true; loginId: string };
    expect(started).toEqual({ started: true, loginId: expect.any(String) });
    const { loginId } = started;
    await tick();
    expect(t.delivered).toEqual([
      { kind: "auth", text: "Sign in with ChatGPT", origin: ORIGIN, auth: { url: "https://auth.openai.com/api/accounts/authorize?state=s1", instructions: LOGIN_INSTRUCTIONS }, loginId },
    ]);

    const result = await t.auth.handlers()[AUTH_METHODS.complete]!({ principalId: "drk", input: PASTE });
    expect(result).toEqual({ ok: true, model: "gpt-6.1-sol" });
    expect(t.record.inputs).toEqual([PASTE]);
    expect(t.loggedIn()).toBe(1);
    expect(t.delivered.at(-1)).toEqual({ kind: "reply", text: "✅ ChatGPT connected · gpt-6.1-sol", origin: ORIGIN, authResult: "ok", loginId });
    expect(t.auth.isPending).toBe(false);
    // The pasted input (and its code) never reaches a log line or a delivery.
    expect(JSON.stringify(t.logs)).not.toContain("SECRET-CODE");
    expect(JSON.stringify(t.delivered)).not.toContain("SECRET-CODE");
  });

  test("a localhost paste is rewritten to Pi's 127.0.0.1 redirect origin", async () => {
    const t = setup();
    t.auth.start(ORIGIN);
    await tick();
    const res = await t.auth.complete(`  ${PASTE.replace("127.0.0.1", "localhost")}\n`);
    expect(res).toEqual({ ok: true, model: "gpt-6.1-sol" });
    expect(t.record.inputs).toEqual([PASTE]);
  });

  test("a paste that arrives before Pi prompts for it is held for the prompt", async () => {
    const t = setup();
    t.auth.start(ORIGIN);
    expect(await t.auth.complete(PASTE)).toEqual({ ok: true, model: "gpt-6.1-sol" });
  });

  test("a second start while one is pending is an error; the first continues", async () => {
    const t = setup();
    t.auth.start(ORIGIN);
    expect(() => t.auth.start(ORIGIN)).toThrow(LOGIN_ALREADY_PENDING);
    await tick();
    expect(await t.auth.complete(PASTE)).toMatchObject({ ok: true });
  });

  test("a bad paste fails the login with Pi's error and frees the slot", async () => {
    const t = setup();
    t.auth.start(ORIGIN);
    await tick();
    const res = await t.auth.complete(PASTE.replace("state=s1", "state=other"));
    expect(res).toEqual({ ok: false, error: "OAuth state mismatch" });
    expect(t.delivered.at(-1)).toEqual({
      kind: "reply",
      text: "❌ ChatGPT sign-in failed: OAuth state mismatch\nSend `!login chatgpt` to try again.",
      origin: ORIGIN,
      authResult: "failed",
      loginId: expect.any(String),
    });
    expect(t.loggedIn()).toBe(0);
    expect(t.auth.isPending).toBe(false);
    expect(JSON.stringify(t.logs)).not.toContain("SECRET-CODE");
  });

  test("complete with no login running says so and delivers nothing", async () => {
    const t = setup();
    expect(await t.auth.complete(PASTE)).toMatchObject({ ok: false, inactive: true });
    expect(t.delivered).toEqual([]);
  });

  test("cancel aborts the login and delivers the cancelled result", async () => {
    const t = setup();
    t.auth.start(ORIGIN);
    await tick();
    expect(await t.auth.handlers()[AUTH_METHODS.cancel]!({ principalId: "drk" })).toEqual({ cancelled: true });
    expect(t.delivered.at(-1)).toEqual({ kind: "reply", text: "ChatGPT sign-in cancelled.", origin: ORIGIN, authResult: "cancelled", loginId: expect.any(String) });
    expect(t.auth.isPending).toBe(false);
    expect(await t.auth.cancel()).toEqual({ cancelled: false });
    // The slot is free again.
    expect(t.auth.start(ORIGIN)).toEqual({ started: true, loginId: expect.any(String) });
    await t.auth.cancel();
  });

  test("times out with a clear message", async () => {
    const t = setup({ timeoutMs: 20 });
    t.auth.start(ORIGIN);
    const deadline = Date.now() + 2000;
    while (t.auth.isPending && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(t.auth.isPending).toBe(false);
    expect(t.delivered.at(-1)).toEqual({
      kind: "reply",
      text: "⌛ ChatGPT sign-in timed out after 10 minutes. Send `!login chatgpt` to try again.",
      origin: ORIGIN,
      authResult: "timeout",
      loginId: expect.any(String),
    });
  });

  test("each login has its own id, carried by its link and its result", async () => {
    const t = setup();
    const first = t.auth.start(ORIGIN).loginId;
    await tick();
    await t.auth.cancel();
    const second = t.auth.start(ORIGIN).loginId;
    await tick();
    await t.auth.cancel();
    expect(first).not.toBe(second);
    expect(t.delivered.map((d) => [d.kind, d.loginId])).toEqual([
      ["auth", first],
      ["reply", first],
      ["auth", second],
      ["reply", second],
    ]);
  });

  test("a token-endpoint error body is never shown or logged, only its status", async () => {
    const t = setup({ fail: (input) => `OpenAI OAuth token request failed (400): {"error":"invalid_grant","detail":"code ${new URL(input).searchParams.get("code")} already used"}` });
    t.auth.start(ORIGIN);
    await tick();
    const res = await t.auth.complete(PASTE);
    expect(res).toEqual({ ok: false, error: "ChatGPT token request failed (HTTP 400)" });
    expect(JSON.stringify(t.delivered)).not.toContain("SECRET-CODE");
    expect(JSON.stringify(t.delivered)).not.toContain("invalid_grant");
    expect(JSON.stringify(t.logs)).not.toContain("SECRET-CODE");
    expect(JSON.stringify(t.logs)).not.toContain("invalid_grant");
  });

  test("any other error echoing the pasted input or its code is scrubbed", async () => {
    const t = setup({ fail: (input) => `weird: ${input} / SECRET-CODE` });
    t.auth.start(ORIGIN);
    await tick();
    const res = await t.auth.complete(PASTE);
    expect(res.ok).toBe(false);
    expect(JSON.stringify([res, t.delivered, t.logs])).not.toContain("SECRET-CODE");
    expect(publicLoginError("OpenAI OAuth token request failed (401): Unauthorized")).toBe("ChatGPT token request failed (HTTP 401)");
    expect(publicLoginError("OAuth state mismatch", ["SECRET-CODE"])).toBe("OAuth state mismatch");
  });

  test("rejects another principal", async () => {
    const t = setup();
    await expect(t.auth.handlers()[AUTH_METHODS.start]!({ principalId: "mallory", provider: "openai", origin: ORIGIN })).rejects.toThrow("principal mismatch");
    await expect(t.auth.handlers()[AUTH_METHODS.complete]!({ principalId: "mallory", input: PASTE })).rejects.toThrow("principal mismatch");
    expect(t.auth.isPending).toBe(false);
  });
});

describe("refuseIfCallbackServerListens", () => {
  const AUTH_URL = { type: "auth_url" as const, url: "https://auth.openai.com/x", instructions: "i" };
  const recorder = () => {
    const events: string[] = [];
    const outer: Interaction = { signal: new AbortController().signal, notify: (e) => void events.push(e.type), prompt: async () => "" };
    return { events, outer };
  };

  test("forwards the sign-in link once Pi reported its callback server couldn't bind", () => {
    const { events, outer } = recorder();
    const g = refuseIfCallbackServerListens(outer);
    g.interaction.notify({ type: "info", message: "Could not listen on http://127.0.0.1:1455/auth/callback; paste the final redirect URL to continue. EADDRINUSE" });
    g.interaction.notify(AUTH_URL);
    expect(events).toEqual(["info", "auth_url"]);
    expect(g.refused.aborted).toBe(false);
    expect(g.interaction.signal!.aborted).toBe(false);
  });

  test("withholds the link and aborts the login when Pi's callback server is listening", () => {
    const { events, outer } = recorder();
    const g = refuseIfCallbackServerListens(outer);
    g.interaction.notify({ type: "progress", message: "starting" });
    g.interaction.notify(AUTH_URL);
    expect(events).toEqual(["progress"]);
    expect(g.refused.aborted).toBe(true);
    expect(g.interaction.signal!.aborted).toBe(true);
  });
});

describe("ReauthNotifier", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("sends one proactive notice per 24h, remembered across restarts", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ws-reauth-"));
    dirs.push(stateDir);
    let now = 1_000_000_000_000;
    const delivered: OutOfBandDelivery[] = [];
    const make = () => new ReauthNotifier({ stateDir, deliver: (d) => delivered.push(d), now: () => now });

    expect(make().notify()).toBe(true);
    expect(delivered).toEqual([{ kind: "proactive", text: REAUTH_NOTICE }]);
    expect(REAUTH_NOTICE).toBe("ChatGPT sign-in expired — using OpenRouter. Send `!login chatgpt` to reconnect.");

    now += 60_000;
    expect(make().notify()).toBe(false);
    now += REAUTH_NOTICE_INTERVAL_MS - 60_001;
    expect(make().notify()).toBe(false);
    now += 1;
    expect(make().notify()).toBe(true);
    expect(delivered).toHaveLength(2);
  });

  test("stays quiet while a login is in progress", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ws-reauth-"));
    dirs.push(stateDir);
    const delivered: OutOfBandDelivery[] = [];
    const notifier = new ReauthNotifier({ stateDir, deliver: (d) => delivered.push(d), suppressed: () => true });
    expect(notifier.notify()).toBe(false);
    expect(delivered).toEqual([]);
  });
});

describe("Outbox sign-in links", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const URL_WITH_STATE =
    "https://auth.openai.com/api/accounts/authorize?client_id=c&state=STATE-VALUE-123&code_challenge=CHALLENGE-VALUE-456&code_challenge_method=S256&nonce=NONCE-789";

  test("the state, code_challenge and nonce never reach disk; the in-memory entry keeps the live link", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ws-outbox-"));
    dirs.push(stateDir);
    const outbox = new Outbox(stateDir);
    outbox.append({ outboxId: "a1", principalId: "drk", kind: "auth", text: "Sign in", auth: { url: URL_WITH_STATE, instructions: "x" }, loginId: "L1" });
    const disk = () => readFileSync(outbox.path, "utf8");
    for (const secret of ["STATE-VALUE-123", "CHALLENGE-VALUE-456", "NONCE-789"]) expect(disk()).not.toContain(secret);
    expect(outbox.unacked()[0]!.auth!.url).toBe(URL_WITH_STATE);
    outbox.ack("a1");
    for (const secret of ["STATE-VALUE-123", "CHALLENGE-VALUE-456"]) expect(disk()).not.toContain(secret);
    expect(new URL(redactAuthUrl(URL_WITH_STATE)).searchParams.get("client_id")).toBe("c");
  });

  test("an unacked sign-in link from a previous process is dropped on load; other entries survive", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ws-outbox-"));
    dirs.push(stateDir);
    const outbox = new Outbox(stateDir);
    outbox.append({ outboxId: "a1", principalId: "drk", kind: "auth", text: "Sign in", auth: { url: URL_WITH_STATE, instructions: "x" } });
    outbox.append({ outboxId: "r1", principalId: "drk", kind: "reply", text: "hi" });
    expect(new Outbox(stateDir).unacked().map((e) => e.outboxId)).toEqual(["r1"]);
  });
});
