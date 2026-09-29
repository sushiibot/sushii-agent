import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory, createWorkspaceBashTool, currentRunId, reloadContext } from "./piChatSession.ts";
import { RunLog } from "./runLog.ts";
import { runWsRuns } from "./wsRuns.ts";

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

function testConfig(): WorkspaceConfig {
  return {
    model: "test/model",
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:9/v1",
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
}

async function realSession(): Promise<AgentSession> {
  const { session } = await createPiChatSessionFactory(testConfig())({ sessionFile: null });
  return session as AgentSession;
}

describe("run log", () => {
  test("a real chat turn is recorded as a main run in the run index", async () => {
    const config = testConfig();
    const runs = new RunLog(config.stateDir);
    // No retries against the unreachable model, so the turn fails fast.
    mkdirSync(config.agentDir, { recursive: true });
    writeFileSync(join(config.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const built = await createPiChatSessionFactory(config, { runs })({ sessionFile: null });
    const { session, sessionFile } = built;
    expect(sessionFile.startsWith(join(config.agentDir, "chat"))).toBe(true);
    const midRun: (string | null)[] = [];
    (session as AgentSession).subscribe((e) => {
      if (e.type === "message_start") midRun.push(built.currentRunId?.() ?? null);
    });
    await (session as AgentSession).prompt("hello there").catch(() => {});
    const [run] = runs.listRuns();
    expect(run).toMatchObject({ agentName: "main", task: "hello there", sessionFile, status: "failed" });
    expect(run.endedAt).toBeDefined();
    expect(midRun).toContain(run.runId);
    expect(built.currentRunId?.()).toBeNull();

    // ws-runs reads the real Pi session file for that run.
    const out: string[] = [];
    const env = { HOME: config.home, WORKSPACE_STATE_DIR: config.stateDir, PI_CODING_AGENT_DIR: config.agentDir };
    expect(runWsRuns(["show", run.runId], { env, agentDirs: [config.agentDir], out: (l) => out.push(l), err: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).toContain("user: hello there");
    expect(out.join("\n")).toContain("[error: 503");
    expect(currentRunId(session)).toBeNull();
    session.dispose();
  }, 20_000);

  test("the agent's bash sees the run in progress as WS_RUN_ID, read per spawn", async () => {
    let runId: string | null = "01RUNA";
    const tool = await createWorkspaceBashTool(root, () => runId);
    const echo = async () => {
      const result = await tool.execute("t", { command: 'echo "id=$WS_RUN_ID"' }, undefined, undefined, {} as never);
      return result.content.map((c) => ("text" in c ? c.text : "")).join("").trim();
    };
    expect(await echo()).toBe("id=01RUNA");
    runId = "01RUNB";
    expect(await echo()).toBe("id=01RUNB");
    runId = null;
    expect(await echo()).toBe("id=");
  });
});

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
