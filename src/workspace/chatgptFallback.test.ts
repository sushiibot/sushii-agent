import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BackendSelector,
  DEFAULT_COOLDOWN_MS,
  NOT_SIGNED_IN_WARNING,
  classifyChatGptError,
  createModelFallbackExtension,
  parseResetAt,
  selectInitialModel,
  type ModelRef,
} from "./chatgptFallback.ts";
import { mapSessionEvent, newRunAccumulator, runUsage } from "./events.ts";

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const USAGE_LIMIT = 'OpenAI API error (429): {"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"usage limit reached"}}';

const primary: ModelRef = { provider: "openai", id: "gpt-6.1-sol" };
const fallback: ModelRef = { provider: "sushii-workspace-openrouter", id: "openai/gpt-6-luna" };

function clock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function recordingLog() {
  const lines: Array<{ level: "info" | "warn"; obj: object; msg: string }> = [];
  return {
    lines,
    info: (obj: object, msg: string) => lines.push({ level: "info", obj, msg }),
    warn: (obj: object, msg: string) => lines.push({ level: "warn", obj, msg }),
  };
}

describe("classifyChatGptError", () => {
  test("usage limits, quota and rate limits are limit failures", () => {
    expect(classifyChatGptError(USAGE_LIMIT)?.reason).toBe("limit");
    expect(classifyChatGptError("OpenAI API error (429): Too Many Requests")?.reason).toBe("limit");
    expect(classifyChatGptError("You exceeded your current quota (insufficient_quota)")?.reason).toBe("limit");
  });

  test("refresh and credential failures are auth failures", () => {
    expect(classifyChatGptError("OAuth refresh failed for openai")?.reason).toBe("auth");
    expect(classifyChatGptError('OpenAI API error (401): {"error":"invalid token"}')?.reason).toBe("auth");
    expect(classifyChatGptError('Authentication failed for "openai". Run /login openai')?.reason).toBe("auth");
  });

  test("ChatGPT usage or user data being unavailable is an unavailable failure, even on a 429", () => {
    expect(classifyChatGptError('OpenAI API error (503): {"code":"subscription_sharing_usage_unavailable"}')?.reason).toBe("unavailable");
    expect(classifyChatGptError('OpenAI API error (429): {"code":"subscription_sharing_user_unavailable"}')?.reason).toBe("unavailable");
  });

  test("other errors don't trigger a fallback", () => {
    expect(classifyChatGptError("OpenAI API error (500): internal error")).toBeNull();
    expect(classifyChatGptError("context length exceeded")).toBeNull();
  });
});

describe("parseResetAt", () => {
  test("reads absolute and relative reset hints", () => {
    expect(parseResetAt(`{"resets_at": ${NOW / 1000 + 600}}`, NOW)).toBe(NOW + 600_000);
    expect(parseResetAt(`"resets_at":"${new Date(NOW + 3_600_000).toISOString()}"`, NOW)).toBe(NOW + 3_600_000);
    expect(parseResetAt('"resets_in_seconds": 120', NOW)).toBe(NOW + 120_000);
    expect(parseResetAt("Please try again in 20 minutes.", NOW)).toBe(NOW + 20 * 60_000);
  });

  test("ignores hints in the past or more than a week out", () => {
    expect(parseResetAt(`"resets_at": ${NOW / 1000 - 10}`, NOW)).toBeUndefined();
    expect(parseResetAt('"resets_in_seconds": 99999999', NOW)).toBeUndefined();
    expect(parseResetAt("no hint here", NOW)).toBeUndefined();
  });
});

describe("BackendSelector", () => {
  test("reports only auth failures to onAuthFailure, and reset ends the cool-down", () => {
    let authFailures = 0;
    const s = new BackendSelector({ primaryEnabled: true, onAuthFailure: () => authFailures++ });
    s.onChatGptFailure("usage limit reached");
    expect(authFailures).toBe(0);
    s.onChatGptFailure("OAuth refresh failed: invalid_grant");
    expect(authFailures).toBe(1);
    expect(s.select(true)).toBe("openrouter");
    s.reset();
    expect(s.coolingDownUntil).toBeNull();
    expect(s.select(true)).toBe("chatgpt");
  });

  test("uses OpenRouter when ChatGPT isn't configured or signed in", () => {
    expect(new BackendSelector({ primaryEnabled: false }).select(true)).toBe("openrouter");
    expect(new BackendSelector({ primaryEnabled: true }).select(false)).toBe("openrouter");
    expect(new BackendSelector({ primaryEnabled: true }).select(true)).toBe("chatgpt");
  });

  test("a limit failure holds OpenRouter for the default cool-down, then returns to ChatGPT", () => {
    const c = clock();
    const s = new BackendSelector({ primaryEnabled: true, now: c.now });
    expect(s.onChatGptFailure(USAGE_LIMIT)).toEqual({ reason: "limit", until: NOW + DEFAULT_COOLDOWN_MS });
    for (let i = 0; i < 5; i++) {
      c.advance(10 * 60_000 - 1);
      expect(s.select(true)).toBe("openrouter");
    }
    c.advance(10 * 60_000 + 5);
    expect(s.select(true)).toBe("chatgpt");
    expect(s.coolingDownUntil).toBeNull();
  });

  test("a reset time in the error sets the cool-down", () => {
    const c = clock();
    const s = new BackendSelector({ primaryEnabled: true, now: c.now });
    s.onChatGptFailure(`${USAGE_LIMIT} "resets_in_seconds": 300`);
    c.advance(299_000);
    expect(s.select(true)).toBe("openrouter");
    c.advance(1000);
    expect(s.select(true)).toBe("chatgpt");
  });

  test("an unavailable failure takes the default cool-down, ignoring any reset hint", () => {
    const s = new BackendSelector({ primaryEnabled: true, now: clock().now });
    expect(s.onChatGptFailure('{"code":"subscription_sharing_usage_unavailable"} "resets_in_seconds": 30')).toEqual({
      reason: "unavailable",
      until: NOW + DEFAULT_COOLDOWN_MS,
    });
    expect(s.select(true)).toBe("openrouter");
  });

  test("an unrelated error starts no cool-down", () => {
    const s = new BackendSelector({ primaryEnabled: true, now: clock().now });
    expect(s.onChatGptFailure("OpenAI API error (500): boom")).toBeNull();
    expect(s.select(true)).toBe("chatgpt");
  });
});

describe("selectInitialModel", () => {
  const config = { provider: "chatgpt" as const, chatgptModel: "gpt-6.1-sol" };
  const runtime = (stored: "oauth" | "api_key" | null, getAuth: () => Promise<unknown> = async () => ({})) => ({
    checkAuth: async () => (stored ? { type: stored } : undefined),
    getAuth,
  });

  test("a stored ChatGPT OAuth credential selects the ChatGPT model", async () => {
    const log = recordingLog();
    const model = await selectInitialModel({ config, runtime: runtime("oauth"), selector: new BackendSelector({ primaryEnabled: true }), primary, fallback, log });
    expect(model).toBe(primary);
    expect(log.lines.filter((l) => l.level === "warn")).toEqual([]);
  });

  test("no login selects OpenRouter and warns how to sign in", async () => {
    const log = recordingLog();
    const model = await selectInitialModel({ config, runtime: runtime(null), selector: new BackendSelector({ primaryEnabled: true }), primary, fallback, log });
    expect(model).toBe(fallback);
    expect(log.lines).toEqual([{ level: "warn", obj: { fallback: fallback.id }, msg: NOT_SIGNED_IN_WARNING }]);
  });

  test("an ambient API key doesn't count as a ChatGPT login", async () => {
    const model = await selectInitialModel({ config, runtime: runtime("api_key"), selector: new BackendSelector({ primaryEnabled: true }), primary, fallback, log: recordingLog() });
    expect(model).toBe(fallback);
  });

  test("a credential whose refresh fails falls back and starts a cool-down", async () => {
    const c = clock();
    const selector = new BackendSelector({ primaryEnabled: true, now: c.now });
    const failing = runtime("oauth", async () => {
      throw new Error("invalid_grant");
    });
    const model = await selectInitialModel({ config, runtime: failing, selector, primary, fallback, log: recordingLog() });
    expect(model).toBe(fallback);
    expect(selector.coolingDownUntil).toBe(NOW + DEFAULT_COOLDOWN_MS);
  });

  test("provider=openrouter never touches ChatGPT", async () => {
    const log = recordingLog();
    const model = await selectInitialModel({
      config: { ...config, provider: "openrouter" },
      runtime: runtime("oauth"),
      selector: new BackendSelector({ primaryEnabled: false }),
      primary,
      fallback,
      log,
    });
    expect(model).toBe(fallback);
    expect(log.lines).toEqual([]);
  });

  test("an unknown ChatGPT model id falls back with a warning", async () => {
    const log = recordingLog();
    const model = await selectInitialModel({ config, runtime: runtime("oauth"), selector: new BackendSelector({ primaryEnabled: true }), primary: undefined, fallback, log });
    expect(model).toBe(fallback);
    expect(log.lines[0].level).toBe("warn");
  });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(opts: { signedIn?: boolean; start?: ModelRef; setModelError?: Error } = {}) {
  const c = clock();
  const selector = new BackendSelector({ primaryEnabled: true, now: c.now });
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as ExtensionAPI;
  let current: ModelRef = opts.start ?? primary;
  const switches: string[] = [];
  const log = recordingLog();
  const factory = createModelFallbackExtension({
    selector,
    primary,
    fallback,
    signedIn: async () => opts.signedIn ?? true,
    setModel: async (m) => {
      if (opts.setModelError && m === primary) throw opts.setModelError;
      switches.push(m.id);
      current = m;
    },
    log,
  });
  void factory(pi);
  const ctx = () => ({ model: current });
  return {
    clock: c,
    selector,
    switches,
    log,
    get model() {
      return current;
    },
    input: (streamingBehavior?: "steer") => handlers.get("input")!({ type: "input", text: "hi", source: "interactive", streamingBehavior }, ctx()),
    startRun: () => handlers.get("before_agent_start")!({ type: "before_agent_start" }, ctx()),
    settle: (message: { provider: string; stopReason: string; errorMessage?: string }, outcome = "error") =>
      handlers.get("agent_before_settle")!(
        {
          type: "agent_before_settle",
          outcome,
          continue: false,
          entries: [],
          context: {
            contextEntries: [
              { sourceEntry: { id: "u1" }, messages: [{ role: "user" }] },
              { sourceEntry: { id: "a1" }, messages: [{ role: "assistant", ...message }] },
            ],
          },
        },
        ctx(),
      ) as Promise<unknown>,
  };
}

describe("model fallback extension", () => {
  test("a ChatGPT usage-limit failure switches to OpenRouter and re-runs the turn once", async () => {
    const h = harness();
    await h.startRun();
    const result = await h.settle({ provider: "openai", stopReason: "error", errorMessage: USAGE_LIMIT });
    expect(result).toEqual({ entries: [{ type: "context_edit", targetId: "a1", replacement: null }], continue: true });
    expect(h.switches).toEqual([fallback.id]);
    expect(h.log.lines.some((l) => l.level === "warn" && l.msg.includes("retrying it on OpenRouter"))).toBe(true);
    // A second ChatGPT-attributed failure in the same run is not retried again.
    expect(await h.settle({ provider: "openai", stopReason: "error", errorMessage: USAGE_LIMIT })).toBeUndefined();
  });

  test("an auth failure falls back the same way", async () => {
    const h = harness();
    await h.startRun();
    expect(await h.settle({ provider: "openai", stopReason: "error", errorMessage: "OAuth refresh failed for openai" })).toMatchObject({ continue: true });
    expect(h.model).toBe(fallback);
  });

  test("OpenRouter failures, unrelated errors and completed runs are left alone", async () => {
    const h = harness();
    await h.startRun();
    expect(await h.settle({ provider: fallback.provider, stopReason: "error", errorMessage: USAGE_LIMIT })).toBeUndefined();
    expect(await h.settle({ provider: "openai", stopReason: "error", errorMessage: "OpenAI API error (500): boom" })).toBeUndefined();
    expect(await h.settle({ provider: "openai", stopReason: "stop" }, "completed")).toBeUndefined();
    expect(h.switches).toEqual([]);
    expect(h.selector.coolingDownUntil).toBeNull();
  });

  test("turns stay on OpenRouter through the cool-down, then return to ChatGPT once", async () => {
    const h = harness();
    await h.startRun();
    await h.settle({ provider: "openai", stopReason: "error", errorMessage: USAGE_LIMIT });
    expect(h.model).toBe(fallback);
    for (let i = 0; i < 3; i++) {
      h.clock.advance(15 * 60_000);
      expect(await h.input()).toEqual({ action: "continue" });
    }
    expect(h.switches).toEqual([fallback.id]);
    h.clock.advance(15 * 60_000);
    await h.input();
    await h.input();
    expect(h.switches).toEqual([fallback.id, primary.id]);
    expect(h.model).toBe(primary);
  });

  test("a steer never switches models mid-run", async () => {
    const h = harness({ start: fallback });
    await h.input("steer");
    expect(h.switches).toEqual([]);
  });

  test("signing out moves the next turn to OpenRouter", async () => {
    const h = harness({ signedIn: false });
    await h.input();
    expect(h.model).toBe(fallback);
  });

  test("a failed switch back to ChatGPT stays on OpenRouter and starts a cool-down", async () => {
    const h = harness({ start: fallback, setModelError: new Error("No API key for openai/gpt-6.1-sol") });
    expect(await h.input()).toEqual({ action: "continue" });
    expect(h.model).toBe(fallback);
    expect(h.selector.coolingDownUntil).toBe(NOW + DEFAULT_COOLDOWN_MS);
  });
});

describe("usage for ChatGPT turns", () => {
  const end = (provider: string, model: string, cost: number) =>
    ({
      type: "message_end",
      message: { role: "assistant", provider, model, content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 10, output: 5, cost: { total: cost } } },
    }) as never;

  test("a ChatGPT turn reports its model and no cost", () => {
    const acc = newRunAccumulator();
    mapSessionEvent(end("openai", "gpt-6.1-sol", 0.42), acc);
    const usage = runUsage(acc, "openai/gpt-6-luna", 5);
    expect(usage.model).toBe("chatgpt/gpt-6.1-sol");
    expect(usage.costUsd).toBeUndefined();
  });

  test("a turn retried on OpenRouter reports the OpenRouter model", () => {
    const acc = newRunAccumulator();
    mapSessionEvent(end("openai", "gpt-6.1-sol", 0), acc);
    mapSessionEvent(end("sushii-workspace-openrouter", "openai/gpt-6-luna", 0), acc);
    expect(runUsage(acc, "unused", undefined).model).toBe("openai/gpt-6-luna");
  });
});
