// The API flows use. Flows run in node under Playwright, so nothing here may import bun:*; anything
// that needs bun (sqlite, process control) goes through the runner's control server.
import { test as base, expect, type Page } from "@playwright/test";
import { stackConfig } from "../stack/config.ts";
import type { LlmRequest } from "../stack/fake-llm.ts";

export { expect };
export type { LlmRequest };

const cfg = stackConfig();
const control = `http://${cfg.addrs.local}:${cfg.ports.control}`;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is unset: run the flows through \`bun run e2e:system\`, not \`playwright test\` directly`);
  return v;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${control}${path}`, init);
  if (!res.ok) throw new Error(`control ${path}: ${res.status} ${await res.text()}`);
  return res;
}

export const stack = {
  config: cfg,
  baseURL: `http://${cfg.addrs.proxy}:${cfg.ports.proxy}`,
  /** The workspace's $HOME (uploads land in `uploads/`). */
  get wsHome() {
    return required("E2E_WS_HOME");
  },
  /** Every chat-completions request the fake model has received, oldest first. */
  async llmLog(): Promise<LlmRequest[]> {
    return (await call("/llm/log")).json() as Promise<LlmRequest[]>;
  },
  /** Waits until a model request matches, and returns it. */
  async waitForLlm(match: (r: LlmRequest) => boolean, timeoutMs = 20_000): Promise<LlmRequest> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await stack.llmLog()).find(match);
      if (hit) return hit;
      if (Date.now() > until) throw new Error("no matching request reached the fake model");
      await new Promise((r) => setTimeout(r, 200));
    }
  },
  /** Read-only query against the bot's SQLite database. */
  async query<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): Promise<T[]> {
    return (await call("/db/query", { method: "POST", body: JSON.stringify({ sql, params }) })).json() as Promise<T[]>;
  },
  /**
   * Sends a bot → workspace RPC over the real orchestration link (through the bot process) and returns the
   * result plus the contract schema's verdict on it, so flows can exercise workspace RPCs the bot doesn't route yet.
   */
  async linkRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<LinkResult<T>> {
    const body = JSON.stringify({ principalId: "owner", method, params: { principalId: "owner", ...params } });
    return (await call("/link/request", { method: "POST", body })).json() as Promise<LinkResult<T>>;
  },
  /** SIGTERMs the bot and starts it again on the same data. `waitReady` also waits for the workspace to re-register. */
  async restartBot(opts: { waitReady?: boolean } = {}): Promise<void> {
    await call(`/bot/restart${opts.waitReady ? "?wait=ready" : ""}`, { method: "POST" });
  },
};

export interface LinkResult<T> {
  result?: T;
  /** The pinned schema's error message when the result doesn't parse; null when it does. */
  schemaError?: string | null;
  bytes?: number;
  error?: string;
}

/** A short random tag. Put `#<nonce>` in a message and the fake model starts each reply with `re-<nonce>`. */
export const nonce = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export interface Watch {
  console: string[];
  /** CSP and Trusted Types violations seen so far (securitypolicyviolation events plus console reports). */
  violations(): Promise<unknown[]>;
}

export const test = base.extend<{ watch: Watch }>({
  watch: async ({ page }, use) => {
    const console: string[] = [];
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: unknown[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        w.__csp.push({ dir: e.violatedDirective, blocked: e.blockedURI, sample: e.sample, src: e.sourceFile }),
      );
    });
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") console.push(`[${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (e) => console.push(`[pageerror] ${e.message}`));
    await use({
      console,
      async violations() {
        const events = await page.evaluate(() => (window as unknown as { __csp?: unknown[] }).__csp ?? []).catch(() => []);
        return [...events, ...console.filter((m) => /Trusted Type|Content Security Policy|Refused to/i.test(m))];
      },
    });
  },
});

export type { Page };
