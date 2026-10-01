import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { RPC_METHODS, type ChatDeliverParams, type JobAlertWire } from "../../orchestration/contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../../orchestration/transport/server.ts";
import { WorkspaceLink, type WorkspaceRpc } from "../../orchestration/workspace/link.ts";
import { SurfaceRegistry, type ReplyView, type SurfaceAdapter } from "../../orchestration/workspace/surface.ts";
import { SqliteChatLog } from "./chatLog.ts";
import type { ChatEnvelope, WebFeature } from "./events.ts";
import { CLEARED_ALERTS_RETENTION_MS, WebHomeStore } from "./homeStore.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPresence } from "./presence.ts";
import type { PushPayload } from "./push.ts";
import { pushFor } from "./pushRules.ts";
import { historyPage } from "./history.ts";
import { WebWorkspaceAdapter } from "./workspaceAdapter.ts";

const P = "drk";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };
const RUN_A = "01J0000000000000000000000A";
const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeRpc implements WorkspaceRpc {
  handler: WorkspaceHandler | null = null;
  calls: Array<{ method: string; params: unknown }> = [];
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return principalId === P ? CONN : undefined;
  }
  async requestWorkspace(_p: string, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return {};
  }
  setWorkspaceHandler(handler: WorkspaceHandler | null): void {
    this.handler = handler;
  }
}

function alert(o: Partial<JobAlertWire> = {}): JobAlertWire {
  return { source: "job", job: "nightly", kind: "failed", trigger: "daily", startedAt: "2026-09-30T04:00:00.000Z", error: "boom", schedule: "daily 04:00", ...o };
}

function deliverAlert(outboxId: string, a: JobAlertWire): ChatDeliverParams {
  return { outboxId, principalId: P, kind: "alert", text: `job ${a.job} ${a.kind}`, alert: a };
}

/** A bot process on `db`: a new one on the same db is a restart. */
function bot(db: Database, opts: { features?: WebFeature[]; sent?: number } = {}) {
  const log = new SqliteChatLog(db);
  const home = new WebHomeStore(db);
  const pushes: PushPayload[] = [];
  const presence = createPresence({ head: () => log.head(), waitMs: 50 });
  const adapter = new WebWorkspaceAdapter({
    log,
    inbound: new WebInboundStore(db),
    presence,
    push: { send: async (p) => (pushes.push(p), { sent: opts.sent ?? 1 }) },
    home,
    features: opts.features ?? ["home", "alerts"],
  });
  const rpc = new FakeRpc();
  const link = new WorkspaceLink({ principalId: P, store: new WorkspaceLinkStore(db), surfaces: new SurfaceRegistry("web", { pinned: true }).register(adapter), owner: () => ({ id: "", name: "drk" }) });
  link.attach(rpc);
  const events: ChatEnvelope[] = [];
  log.subscribe(null, (ev) => events.push(ev));
  const acks = () => rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck).length;
  return { log, home, adapter, link, rpc, events, pushes, acks, presence };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("alert delivery", () => {
  test("is stored, shown on Home and pushed exactly once, resends and a restart included", async () => {
    const db = freshDb();
    const a = bot(db);
    await a.link.deliver(deliverAlert("o1", alert()));
    await a.link.deliver(deliverAlert("o1", alert()));
    await tick();
    // A crash after the commit, before the seen row: the restarted bot has no seen record for it.
    db.run("DELETE FROM workspace_outbox_seen");
    const b = bot(db);
    await b.link.deliver(deliverAlert("o1", alert()));
    await tick();

    expect(b.log.list(["alert"])).toHaveLength(1);
    expect(a.events.filter((e) => e.type === "alert")).toHaveLength(1);
    expect(b.events.filter((e) => e.type === "alert")).toHaveLength(0);
    expect([...a.pushes, ...b.pushes]).toHaveLength(1);
    expect(a.acks() + b.acks()).toBe(3);
    const [open] = b.home.openAlerts();
    expect(open).toMatchObject({ id: "job:nightly", job: "nightly", kind: "failed", error: "boom", firstAt: "2026-09-30T04:00:00.000Z", seq: b.log.list(["alert"])[0]!.seq });
  });

  test("the alert event carries the alert and its text", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o1", alert({ runId: RUN_A })));
    expect(h.log.find("alert", "o1")?.data).toEqual({ key: "o1", alert: alert({ runId: RUN_A }), text: "job nightly failed" });
  });

  test("recovered closes the open streak with alert_cleared, and silently replaces the failure notification", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o1", alert()));
    await h.link.deliver(deliverAlert("o2", alert({ kind: "recovered", startedAt: "2026-10-01T04:00:00.000Z", error: undefined })));
    await h.link.deliver(deliverAlert("o2", alert({ kind: "recovered", startedAt: "2026-10-01T04:00:00.000Z", error: undefined })));
    await tick();
    expect(h.home.openAlerts()).toEqual([]);
    expect(h.log.list(["alert_cleared"]).map((e) => e.data)).toEqual([{ id: "job:nightly", reason: "recovered" }]);
    expect(h.pushes.map((p) => [p.tag, p.silent ?? false])).toEqual([
      ["job:nightly", false],
      ["job:nightly", true],
    ]);
  });

  test("a recovered that overtakes its failure leaves nothing open, and the late failure doesn't push", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o2", alert({ kind: "recovered", startedAt: "2026-10-01T04:00:00.000Z", error: undefined })));
    await h.link.deliver(deliverAlert("o1", alert({ startedAt: "2026-09-30T04:00:00.000Z" })));
    await tick();
    expect(h.home.openAlerts()).toEqual([]);
    expect(h.log.list(["alert"]).map((e) => e.key)).toEqual(["o2", "o1"]);
    expect(h.pushes).toEqual([]);
  });

  test("a stale stuck behind a newer failure neither reopens nor pushes", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o2", alert({ startedAt: "2026-10-01T04:00:00.000Z" })));
    h.home.dismissAlert("nightly");
    await h.link.deliver(deliverAlert("o1", alert({ kind: "stuck", startedAt: "2026-09-30T04:00:00.000Z" })));
    await tick();
    expect(h.home.openAlerts()).toEqual([]);
    expect(h.pushes).toHaveLength(1);
  });

  test("an alert is a permanent chat item and comes back in history", async () => {
    const db = freshDb();
    const h = bot(db);
    await h.link.deliver(deliverAlert("o1", alert()));
    db.run("DELETE FROM web_events WHERE type = 'alert'");
    h.log.prune(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const page = historyPage(h.log, { limit: 10 }, { maxBytes: 1_000_000 });
    expect(page.items).toEqual([{ type: "alert", id: String(h.log.find("alert", "o1")!.seq), at: expect.any(String), outboxId: "o1", alert: alert(), text: "job nightly failed" }]);
  });

  test("a recovered with no open streak, or about an older run, clears nothing", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o0", alert({ kind: "recovered" })));
    await h.link.deliver(deliverAlert("o1", alert({ startedAt: "2026-10-02T04:00:00.000Z" })));
    await h.link.deliver(deliverAlert("o2", alert({ kind: "recovered", startedAt: "2026-10-01T04:00:00.000Z" })));
    expect(h.home.openAlerts()).toHaveLength(1);
    expect(h.log.list(["alert_cleared"])).toEqual([]);
  });

  test("stuck then failed is one streak: the first start is kept, the kind and seq follow the latest", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o1", alert({ kind: "stuck", error: undefined })));
    await h.link.deliver(deliverAlert("o2", alert({ kind: "failed", startedAt: "2026-09-30T04:00:00.000Z" })));
    const [open] = h.home.openAlerts();
    expect(open).toMatchObject({ kind: "failed", firstAt: "2026-09-30T04:00:00.000Z", seq: h.log.find("alert", "o2")!.seq });
    await tick();
    expect(h.pushes.map((p) => p.title)).toEqual(["Scheduled job stuck", "Scheduled job failed"]);
  });

  test("without the alerts feature it still shows in chat and pushes as a chat message, but not on Home's push tag", async () => {
    const h = bot(freshDb(), { features: ["home"] });
    await h.link.deliver(deliverAlert("o1", alert()));
    await h.link.deliver(deliverAlert("o2", alert({ kind: "recovered", startedAt: "2026-10-01T04:00:00.000Z" })));
    await tick();
    expect(h.log.list(["alert"])).toHaveLength(2);
    expect(h.pushes.map((p) => p.tag)).toEqual(["chat", "chat"]);
  });

  test("an older workspace's job alert, sent as proactive text, still shows and pushes as a chat message", async () => {
    const h = bot(freshDb());
    await h.link.deliver({ outboxId: "o1", principalId: P, kind: "proactive", text: "⚠️ scheduled job `nightly` failed" });
    await tick();
    expect(h.log.list(["proactive"]).map((e) => e.data.text)).toEqual(["⚠️ scheduled job `nightly` failed"]);
    expect(h.home.openAlerts()).toEqual([]);
    expect(h.pushes.map((p) => p.tag)).toEqual(["chat"]);
  });

  test("a surface without alertPrompt gets the alert's text as a proactive reply", async () => {
    const sent: ReplyView[] = [];
    const plain = {
      surface: "discord",
      capabilities: { streaming: false, tables: false, richButtons: true, reactions: false, maxMessageChars: 2000 },
      sendReply: async (_o: unknown, r: ReplyView) => void sent.push(r),
    } as unknown as SurfaceAdapter;
    const db = freshDb();
    const rpc = new FakeRpc();
    const link = new WorkspaceLink({ principalId: P, store: new WorkspaceLinkStore(db), surfaces: new SurfaceRegistry("discord").register(plain), owner: () => ({ id: "", name: "drk" }) });
    link.attach(rpc);
    await link.deliver(deliverAlert("o1", alert()));
    expect(sent).toEqual([{ kind: "proactive", text: "job nightly failed", toolCount: null }]);
  });

  test("an alert outside the contract is refused at the link, never stored", async () => {
    const h = bot(freshDb());
    await expect(h.rpc.handler!.onRequest!(CONN, RPC_METHODS.chatDeliver, deliverAlert("o1", alert({ job: "Bad Name" })))).rejects.toThrow();
    await expect(h.rpc.handler!.onRequest!(CONN, RPC_METHODS.chatDeliver, { ...deliverAlert("o1", alert()), kind: "proactive" })).rejects.toThrow();
    expect(h.log.list(["alert", "proactive"])).toEqual([]);
  });
});

describe("register and runs/changed", () => {
  test("the bot advertises alert to its own principal only", () => {
    const h = bot(freshDb(), { features: [] });
    expect(h.rpc.handler!.features!(CONN)).toEqual(["alert"]);
    expect(h.rpc.handler!.features!({ ...CONN, principalId: "someone" })).toEqual([]);
  });

  test("runs/changed reaches listeners; a malformed or foreign one does not", () => {
    const h = bot(freshDb());
    const got: unknown[] = [];
    h.link.onRunsChanged((r) => got.push(r));
    const ok = { principalId: P, runId: RUN_A, kind: "subagent", status: "done" };
    h.rpc.handler!.onNotification!(CONN, RPC_METHODS.runsChanged, ok);
    h.rpc.handler!.onNotification!(CONN, RPC_METHODS.runsChanged, { ...ok, runId: "../x" });
    h.rpc.handler!.onNotification!(CONN, RPC_METHODS.runsChanged, { ...ok, principalId: "someone" });
    expect(got).toEqual([ok]);
  });

  test("runsList sends the principal and rejects a result outside the contract", async () => {
    const h = bot(freshDb());
    h.rpc.requestWorkspace = async (_p, method, params) => {
      h.rpc.calls.push({ method, params });
      return { runs: [{ runId: "nope" }], before: null, truncated: false };
    };
    await expect(h.link.runsList({ limit: 5 })).rejects.toThrow();
    expect(h.rpc.calls.at(-1)).toEqual({ method: RPC_METHODS.runsList, params: { principalId: P, limit: 5 } });
  });
});

describe("Home store", () => {
  test("a dismissed streak stays hidden until the job fails again", async () => {
    const h = bot(freshDb());
    await h.link.deliver(deliverAlert("o1", alert()));
    expect(h.home.dismissAlert("nightly")).toBe(h.log.find("alert", "o1")!.seq);
    expect(h.home.dismissAlert("nightly")).toBeNull();
    expect(h.home.openAlerts()).toEqual([]);
    await h.link.deliver(deliverAlert("o2", alert({ startedAt: "2026-10-01T04:00:00.000Z" })));
    expect(h.home.openAlerts().map((a) => a.seq)).toEqual([h.log.find("alert", "o2")!.seq]);
  });

  test("prune keeps opened runs 30 d, dismissed runs 7 d and cleared streaks 30 d", () => {
    const db = freshDb();
    const store = new WebHomeStore(db, { now: () => 0 });
    const day = 24 * 60 * 60 * 1000;
    store.openRun(RUN_A);
    store.dismissRun(RUN_A);
    store.applyAlert(alert(), 1, "o1");
    store.applyAlert(alert({ kind: "recovered", startedAt: "2026-10-01T04:00:00.000Z" }), 2, "o2");
    store.prune(7 * day + 1);
    expect(store.dismissedRuns([RUN_A]).size).toBe(0);
    expect(store.openedRuns([RUN_A]).size).toBe(1);
    store.prune(30 * day + 1);
    expect(store.openedRuns([RUN_A]).size).toBe(0);
    expect(CLEARED_ALERTS_RETENTION_MS).toBe(30 * day);
    expect(db.query("SELECT count(*) AS n FROM web_alerts").get()).toEqual({ n: 0 });
  });
});

describe("alert push", () => {
  test("failed and stuck push under the job's tag and deep-link to its Home item", () => {
    expect(pushFor({ kind: "alert", alert: { job: "nightly", kind: "failed", error: "**boom** at `x`" } })).toEqual({
      title: "Scheduled job failed",
      body: "nightly: boom at x",
      url: "/inbox?item=job:nightly",
      tag: "job:nightly",
      renotify: true,
    });
    expect(pushFor({ kind: "alert", alert: { job: "nightly", kind: "stuck" } })).toEqual({ title: "Scheduled job stuck", body: "nightly", url: "/inbox?item=job:nightly", tag: "job:nightly", renotify: true });
    expect(pushFor({ kind: "alertRecovered", job: "nightly" })).toEqual({ title: "Scheduled job working again", body: "nightly", url: "/inbox", tag: "job:nightly", silent: true });
  });

  test("a seen receipt for the alert suppresses its push", async () => {
    const h = bot(freshDb());
    h.presence.open("s1");
    await h.link.deliver(deliverAlert("o1", alert()));
    h.presence.seen(h.log.find("alert", "o1")!.seq);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.pushes).toEqual([]);
  });
});
