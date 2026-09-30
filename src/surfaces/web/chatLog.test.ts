import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { SqliteChatLog } from "./chatLog.ts";
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
});
