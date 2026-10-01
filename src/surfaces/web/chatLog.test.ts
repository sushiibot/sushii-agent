import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { INBOUND_RETENTION_MS, PERMANENT_EVENTS, SqliteChatLog, pageQuery } from "./chatLog.ts";
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

  test("chat rows are permanent: neither age nor the row cap removes them, even when they outnumber the cap", () => {
    const { log, advance, now } = setup({ maxRows: 5 });
    const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };
    const files = [{ id: "F".repeat(22), contentType: "image/png", bytes: 1, name: "f.png", inline: true }];
    for (let i = 0; i < 4; i++) {
      log.append("user", { key: `u${i}`, text: "owner", uploadIds: [], at: "t" }, `u${i}`);
      log.append("reply", { key: `r${i}`, text: "reply", files }, `r${i}`);
      log.append("proactive", { key: `p${i}`, text: "ping", files: [] }, `p${i}`);
      log.append("approval", { nonce: `n${i}`, view }, `n${i}`);
      log.append("approval_resolved", { nonce: `n${i}`, decision: "deny" }, `n${i}`);
      log.append("ask", { key: `a${i}`, askId: `k${i}`, question: "q", choices: [] }, `a${i}`);
      log.append("ask_resolved", { askId: `k${i}`, answer: "x" }, `k${i}`);
      log.append("session", { kind: "new" });
    }
    const permanent = log.list(["user", "reply", "proactive", "approval", "approval_resolved", "ask", "ask_resolved", "session"]).length;
    expect(permanent).toBe(32);
    for (let i = 0; i < 20; i++) {
      log.append("status", { clientId: `c${i}`, state: "accepted" });
      log.append("notice", notice(String(i)));
      log.append("turn_final", { turnId: `t${i}`, outcome: "done", summary: null }, `t${i}:done`);
      log.append("auth", { key: `l${i}`, url: "https://x", instructions: "" }, `l${i}`);
    }
    log.prune(0);
    expect(log.list(["status", "notice", "turn_final", "auth"])).toHaveLength(5);
    advance(365 * 24 * 60 * 60 * 1000);
    log.prune(now());
    expect(log.list(["status", "notice", "turn_final", "auth"])).toHaveLength(0);
    expect(log.list(["user", "reply", "proactive", "approval", "approval_resolved", "ask", "ask_resolved", "session"])).toHaveLength(permanent);
    expect(log.find("reply", "r0")!.data.files).toEqual(files);
  });

  test("the database trigger protects exactly the permanent types", () => {
    const { db } = setup();
    const sql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'web_events_keep_chat'").get() as { sql: string }).sql;
    const listed = /old\.type IN \(([^)]*)\)/.exec(sql)![1]!.split(",").map((t) => t.trim().replace(/'/g, ""));
    expect([...listed].sort()).toEqual([...PERMANENT_EVENTS].sort());
  });

  test("the pre-retention prune, as rolled-back code would run it, deletes no chat and keeps pruned_through on real deletes", () => {
    const { db, log, advance, now } = setup();
    const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };
    log.prepend([{ type: "user", key: "pi:1", data: { key: "pi:1", text: "imported", uploadIds: [], at: "t" }, createdAt: 1 }]);
    log.append("user", { key: "u1", text: "owner", uploadIds: [], at: "t" }, "u1");
    log.append("reply", { key: "r1", text: "reply", files: [] }, "r1");
    log.append("approval", { nonce: "n1", view }, "n1");
    log.append("approval_resolved", { nonce: "n1", decision: "approve" }, "n1");
    log.append("ask", { key: "a1", askId: "k1", question: "q", choices: [] }, "a1");
    log.append("ask_resolved", { askId: "k1", answer: "x" }, "k1");
    log.append("session", { kind: "new" });
    const noticeSeq = log.append("notice", notice("old"));
    const chat = () => db.query("SELECT count(*) AS n FROM web_events WHERE type != 'notice'").get() as { n: number };
    const before = chat().n;
    advance(60 * 24 * 60 * 60 * 1000);
    // The prune from before chat was permanent: untyped by age, then a cap exempting only owner messages and undecided approvals.
    const aged = db.query("DELETE FROM web_events WHERE created_at < ? RETURNING seq").all(now() - 30 * 24 * 60 * 60 * 1000) as { seq: number }[];
    const capExempt = `e.type = 'user' OR (e.type = 'approval' AND NOT EXISTS (SELECT 1 FROM web_events r WHERE r.type = 'approval_resolved' AND r.key = e.key))`;
    const evicted = db.query(`DELETE FROM web_events WHERE seq IN (SELECT seq FROM web_events e WHERE NOT (${capExempt}) ORDER BY seq DESC LIMIT -1 OFFSET ?) RETURNING seq`).all(0) as { seq: number }[];
    expect(chat().n).toBe(before);
    expect([...aged, ...evicted].map((r) => r.seq)).toEqual([noticeSeq]);
    expect(Math.max(...aged.map((r) => r.seq), ...evicted.map((r) => r.seq))).toBe(noticeSeq);
    expect(log.find("user", "pi:1")).not.toBeNull();
  });

  test("prepend stores rows below every seq, newest first, skips ones it has, and fans nothing out", () => {
    const { log } = setup();
    const got: ChatEnvelope[] = [];
    const live = log.append("user", { key: "live", text: "live", uploadIds: [], at: "t" }, "live");
    log.subscribe(null, (ev) => got.push(ev));
    const row = (k: string, at: number) => ({ type: "reply" as const, key: k, data: { key: k, text: k, files: [] }, createdAt: at });
    expect(log.prepend([row("pi:3", 3), row("pi:2", 2)])).toBe(2);
    expect(log.prepend([row("pi:2", 2), row("pi:1", 1)])).toBe(1);
    expect(got).toHaveLength(0);
    expect(log.page(["user", "reply"], { limit: 10 }).map((e) => [e.seq, e.key])).toEqual([
      [live, "live"],
      [0, "pi:3"],
      [-1, "pi:2"],
      [-2, "pi:1"],
    ]);
    // Imported rows don't move the stream's head or count as live rows.
    expect(log.head()).toBe(live);
    expect(log.firstLiveAt()).toBe(log.find("user", "live")!.createdAt);
    expect(log.subscribe(0, () => {}).reset).toBe(false);
    expect(log.append("notice", notice("next"))).toBe(live + 1);
  });

  test("with only imported rows, a fresh stream neither resets nor replays them", () => {
    const { log } = setup();
    log.prepend([{ type: "user", key: "pi:1", data: { key: "pi:1", text: "old", uploadIds: [], at: "t" }, createdAt: 1 }]);
    expect(log.head()).toBe(0);
    expect(log.firstLiveAt()).toBeNull();
    const replayed: ChatEnvelope[] = [];
    expect(log.subscribe(0, (ev) => replayed.push(ev)).reset).toBe(false);
    expect(replayed).toEqual([]);
    expect(log.append("notice", notice("first"))).toBe(1);
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

describe("history page query plan", () => {
  test("walks the order index with no sort, and a cursor seeks into it", () => {
    const db = new Database(":memory:");
    applySchema(db);
    for (const before of [undefined, { order: 50, seq: 60 }]) {
      const { sql, params } = pageQuery(["user", "reply"], { limit: 41, ...(before ? { before } : {}) });
      const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join("\n");
      expect(plan).toContain(before ? "SEARCH web_events USING INDEX idx_web_events_order" : "SCAN web_events USING INDEX idx_web_events_order");
      expect(plan).not.toContain("TEMP B-TREE");
    }
  });
});
