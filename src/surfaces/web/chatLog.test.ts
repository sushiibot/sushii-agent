import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { INBOUND_RETENTION_MS, SqliteChatLog } from "./chatLog.ts";
import { WebInboundStore } from "./inbound.ts";
import type { ChatEnvelope } from "./events.ts";

function setup(opts: { maxRows?: number } = {}) {
  const db = new Database(":memory:");
  applySchema(db);
  let t = 1_000_000;
  const log = new SqliteChatLog(db, { now: () => t, ...opts });
  return { db, log, advance: (ms: number) => (t += ms), now: () => t };
}

const notice = (text: string) => ({ type: "commandResult", text }) as const;

describe("SqliteChatLog", () => {
  test("append is idempotent on (type, key) and fans out once", () => {
    const { log } = setup();
    const got: ChatEnvelope[] = [];
    log.subscribe(null, (ev) => got.push(ev));
    const a = log.append("user", { key: "k1", text: "hi", uploadIds: [], at: "t" }, "k1");
    const b = log.append("user", { key: "k1", text: "hi", uploadIds: [], at: "t" }, "k1");
    expect(b).toBe(a);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ seq: a, type: "user", data: { key: "k1", text: "hi", uploadIds: [], at: "t" } });
  });

  test("a duplicate key with different content is dropped, never overwritten", () => {
    const { log } = setup();
    const seq = log.append("reply", { key: "o1", text: "first", files: [] }, "o1");
    expect(log.append("reply", { key: "o1", text: "changed", files: [] }, "o1")).toBe(seq);
    expect(log.find("reply", "o1")!.data.text).toBe("first");
  });

  test("the same key under another type is a separate event", () => {
    const { log } = setup();
    expect(log.append("reply", { key: "x", text: "a", files: [] }, "x")).not.toBe(log.append("proactive", { key: "x", text: "a", files: [] }, "x"));
  });

  test("subscribe replays after the cursor, then streams live, with no gap or duplicate", () => {
    const { log } = setup();
    const s1 = log.append("notice", notice("1"));
    log.append("notice", notice("2"));
    const got: number[] = [];
    const sub = log.subscribe(s1, (ev) => got.push(ev.seq!));
    expect(sub.reset).toBe(false);
    expect(sub.head).toBe(s1 + 1);
    log.append("notice", notice("3"));
    expect(got).toEqual([s1 + 1, s1 + 2]);
    sub.close();
    log.append("notice", notice("4"));
    expect(got).toHaveLength(2);
  });

  test("a cursor past head, or behind a pruned seq, resets without replay", () => {
    const { log, advance, now } = setup();
    const s1 = log.append("notice", notice("old"));
    advance(31 * 24 * 60 * 60 * 1000);
    const s2 = log.append("notice", notice("new"));
    log.prune(now());
    const replayed: ChatEnvelope[] = [];
    expect(log.subscribe(s2 + 5, (ev) => replayed.push(ev)).reset).toBe(true);
    expect(log.subscribe(s1 - 1, (ev) => replayed.push(ev)).reset).toBe(true);
    expect(replayed).toHaveLength(0);
    // Everything after s1 is still retained.
    const ok = log.subscribe(s1, (ev) => replayed.push(ev));
    expect(ok.reset).toBe(false);
    expect(replayed.map((e) => e.seq)).toEqual([s2]);
  });

  test("seqs are never reissued after a full prune", () => {
    const { log, advance, now } = setup();
    const s1 = log.append("notice", notice("a"));
    advance(31 * 24 * 60 * 60 * 1000);
    log.prune(now());
    expect(log.head()).toBe(s1);
    expect(log.subscribe(s1 - 1, () => {}).reset).toBe(true);
    expect(log.subscribe(s1, () => {}).reset).toBe(false);
    expect(log.append("notice", notice("b"))).toBe(s1 + 1);
  });

  test("prune caps the row count, dropping the oldest", () => {
    const { log } = setup({ maxRows: 3 });
    const seqs = [1, 2, 3, 4, 5].map((i) => log.append("notice", notice(String(i))));
    log.prune(0);
    expect(log.list(["notice"]).map((e) => e.seq)).toEqual(seqs.slice(2));
  });

  test("a rolled-back transaction stores and fans out nothing", () => {
    const { log } = setup();
    const got: ChatEnvelope[] = [];
    log.subscribe(null, (ev) => got.push(ev));
    expect(() =>
      log.transaction(() => {
        log.append("notice", notice("x"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(got).toHaveLength(0);
    expect(log.list(["notice"])).toHaveLength(0);
    log.transaction(() => log.append("notice", notice("y")));
    expect(got).toHaveLength(1);
  });

  test("a throwing sink is dropped without affecting others", () => {
    const { log } = setup();
    const got: ChatEnvelope[] = [];
    log.subscribe(null, () => {
      throw new Error("dead");
    });
    log.subscribe(null, (ev) => got.push(ev));
    log.publish({ type: "workspace", data: { state: "online" } });
    log.publish({ type: "workspace", data: { state: "offline" } });
    expect(got).toHaveLength(2);
    expect(log.subscribers).toBe(1);
  });

  test("the row cap never evicts the owner's messages or an undecided approval", () => {
    const { log } = setup({ maxRows: 100 });
    const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };
    log.append("approval", { nonce: "decided", view }, "decided");
    log.append("approval_resolved", { nonce: "decided", decision: "deny" }, "decided");
    log.append("approval", { nonce: "waiting", view }, "waiting");
    log.append("user", { key: "u1", text: "owner", uploadIds: [], at: "t" }, "u1");
    for (let i = 0; i < 200; i++) log.append("turn_final", { turnId: `t${i}`, outcome: "stopped", summary: null }, `t${i}:stopped`);
    log.prune(0);
    expect(log.find("approval", "waiting")).not.toBeNull();
    expect(log.find("user", "u1")).not.toBeNull();
    expect(log.find("approval", "decided")).toBeNull();
    expect(log.list(["turn_final"])).toHaveLength(100);
  });

  test("a cursor inside a gap the cap left above an exempt row still resets", () => {
    const { log } = setup({ maxRows: 2 });
    log.append("user", { key: "u1", text: "owner", uploadIds: [], at: "t" }, "u1");
    const seqs = [2, 3, 4, 5, 6].map((i) => log.append("notice", notice(String(i))));
    log.prune(0);
    expect(log.prunedThrough()).toBe(seqs[2]!);
    expect(log.subscribe(seqs[0]!, () => {}).reset).toBe(true);
    const replayed: ChatEnvelope[] = [];
    expect(log.subscribe(seqs[2]!, (ev) => replayed.push(ev)).reset).toBe(false);
    expect(replayed.map((e) => e.seq)).toEqual(seqs.slice(3));
  });

  test("pending lists undecided approvals in the window and the newest unanswered asks, oldest first", () => {
    const { log, advance, now } = setup();
    const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };
    log.append("approval", { nonce: "stale", view }, "stale");
    advance(60_000);
    const since = now();
    log.append("approval", { nonce: "done", view }, "done");
    log.append("approval_resolved", { nonce: "done", decision: "approve" }, "done");
    const live = log.append("approval", { nonce: "live", view }, "live");
    log.append("ask", { key: "o1", askId: "a1", question: "q1", choices: ["x"] }, "o1");
    log.append("ask", { key: "o2", askId: "a2", question: "q2", choices: [] }, "o2");
    log.append("ask", { key: "o3", askId: "", question: "no id", choices: [] }, "o3");
    log.append("ask", { key: "o4", askId: "a4", question: "q4", choices: ["y"] }, "o4");
    log.append("ask_resolved", { askId: "a4", answer: "y" }, "a4");
    log.append("ask", { key: "o5", askId: "a5", question: "q5", choices: ["z"] }, "o5");
    const pending = log.pending({ approvalsSince: since, asks: 2 });
    expect(pending.approvals.map((a) => [a.seq, a.nonce])).toEqual([[live, "live"]]);
    expect(pending.asks.map((a) => a.key)).toEqual(["o2", "o5"]);
  });

  test("at boot, every approval left undecided is cancelled, however old, and a decided one is left alone", () => {
    const { log, advance } = setup();
    const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };
    log.append("approval", { nonce: "old", view }, "old");
    advance(40 * 60_000);
    log.append("approval", { nonce: "done", view }, "done");
    log.append("approval_resolved", { nonce: "done", decision: "approve" }, "done");
    log.append("approval", { nonce: "fresh", view }, "fresh");
    const got: ChatEnvelope[] = [];
    log.subscribe(null, (ev) => got.push(ev));
    expect(log.cancelUnresolvedApprovals()).toBe(2);
    expect(got.map((e) => e.data)).toEqual([
      { nonce: "old", decision: "cancelled" },
      { nonce: "fresh", decision: "cancelled" },
    ]);
    expect(log.pending({ approvalsSince: 0, asks: 10 }).approvals).toEqual([]);
    expect(log.cancelUnresolvedApprovals()).toBe(0);
  });
});

describe("web_inbound retention", () => {
  test("routed rows go a week after routing; unrouted rows stay until they are a week old themselves", () => {
    const { db } = setup();
    const inbound = new WebInboundStore(db);
    const day = 24 * 60 * 60 * 1000;
    const row = (clientId: string, createdAt: number) => inbound.insert({ clientId, text: "t", uploadIds: [], seq: 1, createdAt });
    const now = 100 * day;
    row("routed-late", now - 10 * day);
    inbound.markRouted("routed-late", now - 2 * day);
    row("routed-early", now - 10 * day);
    inbound.markRouted("routed-early", now - 8 * day);
    row("unrouted-young", now - 6 * day);
    row("unrouted-old", now - 8 * day);
    inbound.prune(now);
    const left = (db.query("SELECT client_id FROM web_inbound ORDER BY client_id").all() as { client_id: string }[]).map((r) => r.client_id);
    expect(left).toEqual(["routed-late", "unrouted-young"]);
    expect(inbound.unrouted(now - INBOUND_RETENTION_MS).map((r) => r.clientId)).toEqual(["unrouted-young"]);
  });
});
