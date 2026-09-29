import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionFactory, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";

/** Pi's provider for Sign in with ChatGPT (not the legacy `openai-codex`). */
export const CHATGPT_PROVIDER = "openai";
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export const NOT_SIGNED_IN_WARNING = "ChatGPT not signed in — send `!login chatgpt` from a chat surface, or run: docker exec -it sushii_agent_workspace pi, then /login openai";

export type Backend = "chatgpt" | "openrouter";
export type FailureReason = "limit" | "unavailable" | "auth";

/** The model identity the host needs: Pi's Model carries more, but only these fields are read here. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** How chat/deliver's usage names the model: ChatGPT turns are marked so they aren't read as OpenAI API spend. */
export function modelLabel(provider: string, modelId: string): string {
  return provider === CHATGPT_PROVIDER ? `chatgpt/${modelId}` : modelId;
}

const LIMIT_PATTERN = /subscription_sharing_usage_limit_exceeded|usage.?limit|insufficient_quota|quota|rate.?limit|too many requests|\(429\)/i;
// Pi retries these itself first; still failing afterwards means the ChatGPT side is down, so no reset hint applies.
const UNAVAILABLE_PATTERN = /subscription_sharing_\w+_unavailable|usage.?unavailable/i;
const AUTH_PATTERN =
  /OAuth refresh failed|OAuth auth derivation failed|Authentication failed|No API key|\((?:401|403)\)|invalid_grant|unauthori[sz]ed|invalid.?api.?key|token.{0,20}(?:expired|revoked)/i;

export function classifyChatGptError(errorMessage: string, now = Date.now()): { reason: FailureReason; resetAt?: number } | null {
  if (UNAVAILABLE_PATTERN.test(errorMessage)) return { reason: "unavailable" };
  if (LIMIT_PATTERN.test(errorMessage)) {
    const resetAt = parseResetAt(errorMessage, now);
    return resetAt === undefined ? { reason: "limit" } : { reason: "limit", resetAt };
  }
  if (AUTH_PATTERN.test(errorMessage)) return { reason: "auth" };
  return null;
}

/** Best-effort reset time from a limit error; the exact ChatGPT error body is not documented. */
export function parseResetAt(text: string, now = Date.now()): number | undefined {
  let at: number | undefined;
  const absolute = text.match(/"?resets?_at"?\s*[:=]\s*"?([0-9]{10,13}|\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i);
  const relative =
    text.match(/"?(?:resets?_in|retry_after)(?:_seconds)?"?\s*[:=]\s*"?(\d+)/i) ?? text.match(/(?:try again|resets?) in (\d+)\s*(s|sec|seconds?|m|mins?|minutes?|h|hours?)\b/i);
  if (absolute) {
    const raw = absolute[1];
    at = /^\d+$/.test(raw) ? (raw.length === 13 ? Number(raw) : Number(raw) * 1000) : Date.parse(raw);
  } else if (relative) {
    const unit = (relative[2] ?? "s").toLowerCase()[0];
    at = now + Number(relative[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
  }
  if (at === undefined || !Number.isFinite(at) || at <= now || at > now + MAX_COOLDOWN_MS) return undefined;
  return at;
}

/** Which backend each turn starts on: ChatGPT while signed in, OpenRouter for a cool-down after a ChatGPT failure. */
export class BackendSelector {
  private fallbackUntil = 0;
  private readonly now: () => number;

  constructor(private readonly opts: { primaryEnabled: boolean; cooldownMs?: number; now?: () => number; onAuthFailure?: () => void }) {
    this.now = opts.now ?? (() => Date.now());
  }

  select(signedIn: boolean): Backend {
    if (!this.opts.primaryEnabled || !signedIn) return "openrouter";
    return this.now() < this.fallbackUntil ? "openrouter" : "chatgpt";
  }

  get coolingDownUntil(): number | null {
    return this.now() < this.fallbackUntil ? this.fallbackUntil : null;
  }

  /** Starts (or extends) the cool-down for a limit/auth failure; null when the error doesn't warrant falling back. */
  onChatGptFailure(errorMessage: string): { reason: FailureReason; until: number } | null {
    const now = this.now();
    const failure = classifyChatGptError(errorMessage, now);
    if (!failure) return null;
    const until = failure.resetAt ?? now + (this.opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.fallbackUntil = Math.max(this.fallbackUntil, until);
    if (failure.reason === "auth") this.opts.onAuthFailure?.();
    return { reason: failure.reason, until: this.fallbackUntil };
  }

  /** Ends the cool-down, e.g. after a fresh login. */
  reset(): void {
    this.fallbackUntil = 0;
  }
}

export interface AuthRuntime {
  checkAuth(providerId: string): Promise<{ type?: string } | undefined>;
  getAuth(providerId: string): Promise<unknown>;
}

/** Signed in = a stored ChatGPT OAuth credential. Read fresh, so a login from the CLI shows up without a restart. */
export async function chatGptSignedIn(runtime: Pick<AuthRuntime, "checkAuth">): Promise<boolean> {
  try {
    return (await runtime.checkAuth(CHATGPT_PROVIDER))?.type === "oauth";
  } catch {
    return false;
  }
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Picks the model a new session starts on; never throws for a missing or broken login. */
export async function selectInitialModel<M extends ModelRef>(input: {
  config: Pick<WorkspaceConfig, "provider" | "chatgptModel">;
  runtime: AuthRuntime;
  selector: BackendSelector;
  primary: M | undefined;
  fallback: M;
  log: Log;
}): Promise<M> {
  const { config, runtime, selector, primary, fallback, log } = input;
  if (config.provider !== "chatgpt") return fallback;
  if (!primary) {
    log.warn({ model: config.chatgptModel }, "ChatGPT model not in Pi's openai catalog; using OpenRouter");
    return fallback;
  }
  if (!(await chatGptSignedIn(runtime))) {
    log.warn({ fallback: fallback.id }, NOT_SIGNED_IN_WARNING);
    return fallback;
  }
  if (selector.select(true) !== "chatgpt") return fallback;
  try {
    // Refreshes an expired token now, so a dead refresh token falls back here instead of failing the first turn.
    await runtime.getAuth(CHATGPT_PROVIDER);
  } catch (err) {
    const decision = selector.onChatGptFailure(`OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn({ err, until: decision && new Date(decision.until).toISOString() }, "ChatGPT credential unusable; using OpenRouter");
    return fallback;
  }
  log.info({ model: primary.id }, "using ChatGPT sign-in");
  return primary;
}

interface FailedMessage {
  role: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
}

function lastAssistant(context: AgentBeforeSettleEvent["context"]): { entryId: string; message: FailedMessage } | null {
  for (let i = context.contextEntries.length - 1; i >= 0; i--) {
    const entry = context.contextEntries[i];
    for (let j = entry.messages.length - 1; j >= 0; j--) {
      const message = entry.messages[j] as FailedMessage;
      if (message.role === "assistant") return { entryId: entry.sourceEntry.id, message };
    }
  }
  return null;
}

export interface FallbackExtensionDeps<M extends ModelRef> {
  selector: BackendSelector;
  primary: M | undefined;
  fallback: M;
  signedIn: () => Promise<boolean>;
  /** The live session's setModel; checks auth against the credential store rather than Pi's cached snapshot. */
  setModel: (model: M) => Promise<void>;
  log: Log;
}

/**
 * Pi extension that moves the session between ChatGPT and OpenRouter:
 * at the start of an idle prompt it picks the backend, and when a ChatGPT turn fails on a usage limit
 * or auth error it switches to OpenRouter and re-runs that turn once, inside the same run.
 */
export function createModelFallbackExtension<M extends ModelRef>(deps: FallbackExtensionDeps<M>): ExtensionFactory {
  const { selector, primary, fallback, log } = deps;
  return (pi) => {
    let retriedThisRun = false;

    // `input` runs before prompt()'s auth preflight, so a stale model is replaced before it can fail the turn.
    pi.on("input", async (event, ctx): Promise<InputEventResult> => {
      if (event.streamingBehavior || !primary) return { action: "continue" };
      const want = selector.select(await deps.signedIn());
      const onChatGpt = ctx.model?.provider === CHATGPT_PROVIDER;
      try {
        if (want === "chatgpt" && !onChatGpt) {
          await deps.setModel(primary);
          log.info({ model: primary.id }, "back on ChatGPT");
        } else if (want === "openrouter" && onChatGpt) {
          await deps.setModel(fallback);
          log.warn({ model: fallback.id, until: selector.coolingDownUntil }, "ChatGPT unavailable; turn runs on OpenRouter");
        }
      } catch (err) {
        const decision = selector.onChatGptFailure(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
        log.warn({ err, until: decision && new Date(decision.until).toISOString() }, "could not switch to ChatGPT; staying on OpenRouter");
      }
      return { action: "continue" };
    });

    pi.on("before_agent_start", () => {
      retriedThisRun = false;
    });

    pi.on("agent_before_settle", async (event): Promise<BoundaryResult | undefined> => {
      if (event.outcome !== "error" || retriedThisRun) return undefined;
      const failed = lastAssistant(event.context);
      if (!failed || failed.message.stopReason !== "error" || failed.message.provider !== CHATGPT_PROVIDER) return undefined;
      const error = failed.message.errorMessage ?? "";
      const decision = selector.onChatGptFailure(error);
      if (!decision) return undefined;
      retriedThisRun = true;
      try {
        await deps.setModel(fallback);
      } catch (err) {
        log.warn({ err }, "could not switch to OpenRouter after a ChatGPT failure");
        return undefined;
      }
      log.warn(
        { reason: decision.reason, until: new Date(decision.until).toISOString(), model: fallback.id, error: error.slice(0, 300) },
        "ChatGPT turn failed; retrying it on OpenRouter",
      );
      // Omitting the failed attempt leaves the context runnable, so `continue` re-requests the same turn.
      return { entries: [...event.entries, { type: "context_edit", targetId: failed.entryId, replacement: null }], continue: true };
    });
  };
}
