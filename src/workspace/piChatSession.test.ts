import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory, reloadContext } from "./piChatSession.ts";

let root: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-pichat-"));
  // No network: the OpenRouter catalog lookup falls back to its default context window.
  globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

async function realSession(): Promise<AgentSession> {
  const config = {
    model: "test/model",
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:9/v1",
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
  const { session } = await createPiChatSessionFactory(config)({ sessionFile: null });
  return session as AgentSession;
}

describe("reloadContext", () => {
  test("keeps the compaction reserve override across a reload", async () => {
    const session = await realSession();
    const reserve = session.settingsManager.getCompactionSettings().reserveTokens;
    expect(reserve).toBeGreaterThan(16_384);
    await reloadContext(session);
    expect(session.settingsManager.getCompactionSettings().reserveTokens).toBe(reserve);
    session.dispose();
  });

  test("re-applies the override even when the reload fails midway", async () => {
    const session = await realSession();
    const reserve = session.settingsManager.getCompactionSettings().reserveTokens;
    session.reload = async () => {
      await session.settingsManager.reload();
      throw new Error("resource reload failed");
    };
    await expect(reloadContext(session)).rejects.toThrow("resource reload failed");
    expect(session.settingsManager.getCompactionSettings().reserveTokens).toBe(reserve);
    session.dispose();
  });
});
