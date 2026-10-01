import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { HISTORY_SEARCH_TIMEOUT_MS, RPC_METHODS, RUNS_TIMEOUT_MS } from "../contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../transport/server.ts";
import { WorkspaceBadResponseError, WorkspaceLink, type WorkspaceRpc } from "./link.ts";
import { SurfaceRegistry } from "./surface.ts";

const P = "drk";
const RUN = "01J9ZZZZZZZZZZZZZZZZZZZZZZ";

class Rpc implements WorkspaceRpc {
  calls: { method: string; params: unknown; timeoutMs: number | undefined }[] = [];
  constructor(private readonly reply: (method: string) => unknown) {}
  getWorkspaceConnection(): ConnectionInfo | undefined {
    return { runnerId: "ws", principalId: P, role: "workspace", protocolVersion: 1, state: "idle" };
  }
  async requestWorkspace(_p: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    return this.reply(method);
  }
  setWorkspaceHandler(_h: WorkspaceHandler | null): void {}
}

function link(reply: (method: string) => unknown) {
  const db = new Database(":memory:");
  applySchema(db);
  const rpc = new Rpc(reply);
  const l = new WorkspaceLink({ principalId: P, store: new WorkspaceLinkStore(db), surfaces: new SurfaceRegistry("test"), owner: () => ({ id: "o", name: "drk" }) });
  l.attach(rpc);
  return { l, rpc };
}

const summary = { runId: RUN, kind: "job", agentName: "job:x", title: "t", status: "done", startedAt: "2026-09-30T10:00:00.000Z" };

describe("WorkspaceLink reads", () => {
  test("each read sends the principal, applies defaults and uses its timeout", async () => {
    const { l, rpc } = link((m) => {
      if (m === RPC_METHODS.runsList) return { runs: [summary], before: null, truncated: false };
      if (m === RPC_METHODS.runsGet) return { found: false };
      if (m === RPC_METHODS.historyDays) return { days: [], before: null };
      if (m === RPC_METHODS.historyDay) return { found: false };
      return { hits: [], before: null, truncated: false };
    });
    expect((await l.runsList({ kinds: ["job"] })).runs).toHaveLength(1);
    expect(await l.runsGet({ runId: RUN })).toEqual({ found: false });
    await l.historyDays({});
    await l.historyDay({ date: "2026-09-30" });
    await l.historySearch({ query: "  needle " });
    expect(rpc.calls).toEqual([
      { method: "runs/list", params: { principalId: P, kinds: ["job"], limit: 30 }, timeoutMs: RUNS_TIMEOUT_MS },
      { method: "runs/get", params: { principalId: P, runId: RUN, limit: 100 }, timeoutMs: RUNS_TIMEOUT_MS },
      { method: "history/days", params: { principalId: P, limit: 30 }, timeoutMs: RUNS_TIMEOUT_MS },
      { method: "history/day", params: { principalId: P, date: "2026-09-30" }, timeoutMs: RUNS_TIMEOUT_MS },
      { method: "history/search", params: { principalId: P, query: "needle", scope: "all", limit: 20 }, timeoutMs: HISTORY_SEARCH_TIMEOUT_MS },
    ]);
  });

  test("a result outside the contract rejects the whole response", async () => {
    const { l } = link(() => ({ runs: [{ ...summary, runId: "../etc" }], before: null, truncated: false }));
    await expect(l.runsList({})).rejects.toBeInstanceOf(WorkspaceBadResponseError);
    const { l: l2 } = link(() => ({ found: true, date: "2026-02-30", sessions: [], runs: [], truncated: false }));
    await expect(l2.historyDay({ date: "2026-02-28" })).rejects.toBeInstanceOf(WorkspaceBadResponseError);
  });

  test("params outside the contract never reach the workspace", async () => {
    const { l, rpc } = link(() => ({}));
    await expect(l.runsGet({ runId: "not-a-run" })).rejects.toThrow();
    await expect(l.historyDay({ date: "2026-13-01" })).rejects.toThrow();
    expect(rpc.calls).toEqual([]);
  });
});
