import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AUTH_METHODS,
  LOGIN_ALREADY_PENDING,
  authCancelParams,
  authCompleteParams,
  authStartParams,
  type AuthCancelResult,
  type AuthCompleteResult,
  type AuthStartResult,
  type ChatDeliverParams,
  type ChatOrigin,
} from "../orchestration/contracts.ts";
import { getLogger } from "../logger.ts";
import { CHATGPT_PROVIDER } from "./chatgptFallback.ts";
import { readJson, writeFileAtomic } from "./files.ts";

type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const REAUTH_NOTICE_INTERVAL_MS = 24 * 60 * 60_000;

/** Pi's redirect URI; a pasted `localhost` callback is rewritten to it, since Pi compares origins exactly. */
const REDIRECT_ORIGIN = "http://127.0.0.1:1455";
const LOCALHOST_ORIGIN = /^http:\/\/localhost:1455(?=\/)/i;
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
// Pi's info line when its callback server can't bind; Pi then waits for the pasted URL only.
const LISTEN_FAILED_RE = /^Could not listen on /;
// Pi's token-endpoint error embeds the raw response body after the status.
const TOKEN_ERROR_RE = /OpenAI OAuth token request failed \((\d{3})\)/;
const ERROR_MAX = 300;

export const LOGIN_INSTRUCTIONS =
  "After signing in your browser shows a page that won't load — copy its address (starts with http://127.0.0.1:1455/…) and paste it here. `!login cancel` to abort.";
export const REAUTH_NOTICE = "ChatGPT sign-in expired — using OpenRouter. Send `!login chatgpt` to reconnect.";

export function loginResultText(result: { status: "ok"; model: string } | { status: "failed"; error: string } | { status: "cancelled" | "timeout" }): string {
  switch (result.status) {
    case "ok":
      return `✅ ChatGPT connected · ${result.model}`;
    case "failed":
      return `❌ ChatGPT sign-in failed: ${result.error}\nSend \`!login chatgpt\` to try again.`;
    case "timeout":
      return "⌛ ChatGPT sign-in timed out after 10 minutes. Send `!login chatgpt` to try again.";
    case "cancelled":
      return "ChatGPT sign-in cancelled.";
  }
}

/** Runs one provider login with `interaction`; resolves once the credential is stored. */
export type LoginFn = (interaction: AuthInteraction) => Promise<void>;

/** An out-of-band delivery: outboxed like a reply, never part of the session history. */
export type OutOfBandDelivery = Pick<ChatDeliverParams, "kind" | "text" | "origin" | "auth" | "authResult" | "loginId">;

export interface AuthLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Pi's own ChatGPT login (ModelRuntime.login → openaiChatGPTOAuth.login), writing through Pi's file
 * credential store (locked auth.json under `agentDir`) with the device id Pi keeps in its global settings.
 *
 * Pi's callback server would let anything inside the container (the agent's bash) finish the login with
 * its own code, so the port is held for the whole login and a login where Pi still listened is refused.
 */
export function piChatGptLogin(input: { agentDir: string; cwd: string }): LoginFn {
  return async (interaction) => {
    const { CredentialSynchronizationError, ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    mkdirSync(input.agentDir, { recursive: true });
    const authPath = join(input.agentDir, "auth.json");
    const modelsPath = join(input.agentDir, "models.json");
    if (!existsSync(authPath)) writeFileSync(authPath, "{}");
    if (!existsSync(modelsPath)) writeFileSync(modelsPath, "{}");
    const runtime = await ModelRuntime.create({ authPath, modelsPath });
    const settings = SettingsManager.create(input.cwd, input.agentDir);
    const blocker = await holdCallbackPort();
    const { interaction: guarded, refused } = refuseIfCallbackServerListens(interaction);
    try {
      await runtime.login(CHATGPT_PROVIDER, "oauth", guarded, { getDeviceId: () => settings.getOrCreateDeviceId() });
    } catch (err) {
      if (refused.aborted) throw new Error("ChatGPT's local callback server is listening in the workspace; refusing to sign in");
      // Thrown after the credential was written, when only this runtime's own snapshot failed to update.
      if (err instanceof CredentialSynchronizationError && (await runtime.checkAuth(CHATGPT_PROVIDER))?.type === "oauth") return;
      throw err;
    } finally {
      blocker?.close();
    }
  };
}

/** Withholds the sign-in link and aborts the login unless Pi reported its callback server failed to bind. */
export function refuseIfCallbackServerListens(interaction: AuthInteraction): { interaction: AuthInteraction; refused: AbortSignal } {
  const refused = new AbortController();
  let listenFailed = false;
  return {
    refused: refused.signal,
    interaction: {
      ...interaction,
      signal: AbortSignal.any([interaction.signal ?? new AbortController().signal, refused.signal]),
      notify: (event) => {
        if (event.type === "info" && LISTEN_FAILED_RE.test(event.message)) listenFailed = true;
        if (event.type === "auth_url" && !listenFailed) {
          refused.abort();
          return;
        }
        interaction.notify(event);
      },
    },
  };
}

/** Binds Pi's callback port so Pi's own server can't; null when something else already holds it. */
async function holdCallbackPort(): Promise<Server | null> {
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve(server));
  });
}

/** Drops Pi's echoed token-endpoint body and anything from the pasted callback before a message is shown or logged. */
export function publicLoginError(message: string, secrets: readonly string[] = []): string {
  const token = TOKEN_ERROR_RE.exec(message);
  if (token) return `ChatGPT token request failed (HTTP ${token[1]})`;
  let out = message;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return clip(out);
}

/** The pasted input and its `code` value, for scrubbing error text. */
function secretsOf(input: string): string[] {
  const out = [input];
  try {
    const code = new URL(input).searchParams.get("code");
    if (code) out.push(code);
  } catch {
    // Not a URL; the whole input is still scrubbed.
  }
  return out.filter((s) => s.length >= 4);
}

interface PendingLogin {
  loginId: string;
  origin: ChatOrigin;
  secrets: string[];
  controller: AbortController;
  ending: "cancel" | "timeout" | null;
  timer: ReturnType<typeof setTimeout>;
  code: { resolve: (input: string) => void; reject: (err: Error) => void } | null;
  earlyInput: string | null;
  done: Promise<AuthCompleteResult>;
}

export interface AuthLoginOptions {
  principalId: string;
  login: LoginFn;
  deliver: (d: OutOfBandDelivery) => void;
  /** The ChatGPT model the next turn will use, named in the success message. */
  model: string;
  /** After a stored login, e.g. to end the fallback's cool-down. */
  onLoggedIn?: () => void;
  timeoutMs?: number;
  log?: AuthLog;
}

/** One ChatGPT login at a time, driven from a chat surface: the auth URL goes out as a delivery and the
 *  pasted callback URL comes back through auth/complete. The pasted input is never logged or stored. */
export class AuthLogin {
  private pending: PendingLogin | null = null;
  private readonly log: AuthLog;

  constructor(private readonly opts: AuthLoginOptions) {
    this.log = opts.log ?? getLogger("workspace.auth");
  }

  get isPending(): boolean {
    return this.pending !== null;
  }

  handlers(): Record<string, (params: unknown) => Promise<unknown>> {
    return {
      [AUTH_METHODS.start]: async (p) => {
        const params = authStartParams.parse(p);
        this.assertPrincipal(params.principalId);
        return this.start(params.origin);
      },
      [AUTH_METHODS.complete]: async (p) => {
        const params = authCompleteParams.parse(p);
        this.assertPrincipal(params.principalId);
        return this.complete(params.input);
      },
      [AUTH_METHODS.cancel]: async (p) => {
        this.assertPrincipal(authCancelParams.parse(p).principalId);
        return this.cancel();
      },
    };
  }

  start(origin: ChatOrigin): AuthStartResult {
    if (this.pending) throw new Error(LOGIN_ALREADY_PENDING);
    const controller = new AbortController();
    const pending: PendingLogin = {
      loginId: randomUUID(),
      origin,
      secrets: [],
      controller,
      ending: null,
      timer: setTimeout(() => {
        pending.ending = "timeout";
        controller.abort();
      }, this.opts.timeoutMs ?? LOGIN_TIMEOUT_MS),
      code: null,
      earlyInput: null,
      done: Promise.resolve({ ok: false, error: "" }),
    };
    pending.timer.unref?.();
    this.pending = pending;
    pending.done = this.run(pending);
    this.log.info({ origin: origin.surface, loginId: pending.loginId }, "ChatGPT login started");
    return { started: true, loginId: pending.loginId };
  }

  async complete(input: string): Promise<AuthCompleteResult> {
    const pending = this.pending;
    if (!pending) return { ok: false, error: "No ChatGPT sign-in in progress — send `!login chatgpt` to start one.", inactive: true };
    const normalized = input.trim().replace(LOCALHOST_ORIGIN, REDIRECT_ORIGIN);
    pending.secrets.push(...secretsOf(input.trim()), ...secretsOf(normalized));
    if (pending.code) pending.code.resolve(normalized);
    else pending.earlyInput = normalized;
    return pending.done;
  }

  async cancel(): Promise<AuthCancelResult> {
    const pending = this.pending;
    if (!pending) return { cancelled: false };
    pending.ending ??= "cancel";
    pending.controller.abort();
    await pending.done;
    return { cancelled: true };
  }

  private async run(pending: PendingLogin): Promise<AuthCompleteResult> {
    const interaction: AuthInteraction = {
      signal: pending.controller.signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          this.opts.deliver({
            kind: "auth",
            text: "Sign in with ChatGPT",
            origin: pending.origin,
            auth: { url: event.url, instructions: LOGIN_INSTRUCTIONS },
            loginId: pending.loginId,
          });
        } else {
          // Pi's info/progress lines (e.g. the callback port being busy) carry no secrets.
          this.log.info({ type: event.type, message: "message" in event ? event.message : undefined, loginId: pending.loginId }, "ChatGPT login progress");
        }
      },
      prompt: (prompt) => this.promptFor(pending, prompt),
    };
    let result: AuthCompleteResult;
    let text: string;
    let authResult: NonNullable<ChatDeliverParams["authResult"]>;
    try {
      await this.opts.login(interaction);
      result = { ok: true, model: this.opts.model };
      text = loginResultText({ status: "ok", model: this.opts.model });
      authResult = "ok";
      this.log.info({ model: this.opts.model }, "ChatGPT login stored");
      try {
        this.opts.onLoggedIn?.();
      } catch (err) {
        this.log.warn({ err }, "post-login hook failed");
      }
    } catch (err) {
      if (pending.ending) {
        result = { ok: false, error: pending.ending === "timeout" ? "timed out" : "cancelled" };
        text = loginResultText({ status: pending.ending === "timeout" ? "timeout" : "cancelled" });
        authResult = pending.ending === "timeout" ? "timeout" : "cancelled";
      } else {
        const error = publicLoginError(err instanceof Error ? err.message : String(err), pending.secrets);
        result = { ok: false, error };
        text = loginResultText({ status: "failed", error });
        authResult = "failed";
      }
      this.log.warn({ reason: authResult, error: result.ok ? undefined : result.error, loginId: pending.loginId }, "ChatGPT login ended without a credential");
    } finally {
      clearTimeout(pending.timer);
      pending.secrets = [];
      if (this.pending === pending) this.pending = null;
    }
    this.opts.deliver({ kind: "reply", text, origin: pending.origin, authResult, loginId: pending.loginId });
    return result;
  }

  private promptFor(pending: PendingLogin, prompt: AuthPrompt): Promise<string> {
    if (prompt.type !== "manual_code") return Promise.reject(new Error(`unsupported login prompt: ${prompt.type}`));
    const signal = prompt.signal ?? pending.controller.signal;
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Login cancelled"));
      const onAbort = () => reject(new Error("Login cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = (fn: () => void) => {
        signal.removeEventListener("abort", onAbort);
        pending.code = null;
        fn();
      };
      pending.code = { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)) };
      if (pending.earlyInput !== null) {
        const early = pending.earlyInput;
        pending.earlyInput = null;
        pending.code.resolve(early);
      }
    });
  }

  private assertPrincipal(principalId: string): void {
    if (principalId !== this.opts.principalId) throw new Error(`principal mismatch: this workspace serves ${this.opts.principalId}, got ${principalId}`);
  }
}

function clip(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
}

/** At most one "sign-in expired" message per interval, remembered across restarts in the state dir. */
export class ReauthNotifier {
  private readonly path: string;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      stateDir: string;
      deliver: (d: OutOfBandDelivery) => void;
      /** Skips the notice, e.g. while a login is already in progress. */
      suppressed?: () => boolean;
      intervalMs?: number;
      now?: () => number;
    },
  ) {
    this.path = join(opts.stateDir, "reauth-notice.json");
    this.now = opts.now ?? Date.now;
  }

  /** True when the notice went out. */
  notify(): boolean {
    if (this.opts.suppressed?.()) return false;
    const last = readJson<{ lastSentAt?: number }>(this.path)?.lastSentAt ?? 0;
    const now = this.now();
    if (now - last < (this.opts.intervalMs ?? REAUTH_NOTICE_INTERVAL_MS)) return false;
    writeFileAtomic(this.path, `${JSON.stringify({ lastSentAt: now })}\n`);
    this.opts.deliver({ kind: "proactive", text: REAUTH_NOTICE });
    return true;
  }
}
