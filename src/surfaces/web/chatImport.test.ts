import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import type { ChatExportItem, ChatExportResult } from "../../orchestration/contracts.ts";
import { RpcErrorReply } from "../../orchestration/transport/server.ts";
import { createPiChatImporter, IMPORT_CUTOFF_KEY, IMPORT_DONE_KEY, importPiChat, type ExportSource } from "./chatImport.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { historyPage } from "./history.ts";

const T0 = Date.UTC(2026, 8, 1);
const CLIENT = "01J9Z3W8K2M4N6P8Q0R2S4T6V8";

function setup() {
  const db = new Database(":memory:");
  applySchema(db);
  let t = T0 + 10 * 86_400_000;
  const log = new SqliteChatLog(db, { now: () => t });
  return { db, log, now: () => t, advance: (ms: number) => (t += ms) };
}

const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const u = (n: number, extra: Partial<ChatExportItem> = {}): ChatExportItem => ({ id: `s:u${n}`, role: "user", at: at(n), text: `question ${n}`, ...extra });
const a = (n: number, extra: Partial<ChatExportItem> = {}): ChatExportItem => ({ id: `s:a${n}`, role: "assistant", at: at(n), text: `answer ${n}`, ...extra });

/** Pages `items` (oldest first) the way the workspace does: newest first, `before` = oldest id on the page. */
function source(items: ChatExportItem[], opts: { pageSize?: number; failOn?: (call: number) => boolean } = {}) {
  let calls = 0;
  const src: ExportSource & { calls: () => number } = {
    calls: () => calls,
    async chatExport(q): Promise<ChatExportResult> {
      calls++;
      if (opts.failOn?.(calls)) throw new Error("link dropped");
      const end = q.before === undefined ? items.length : items.findIndex((i) => i.id === q.before);
      const start = Math.max(0, end - Math.min(q.limit, opts.pageSize ?? q.limit));
      const page = items.slice(start, end);
      return { items: page, before: start > 0 ? page[0]!.id : null };
    },
  };
  return src;
}

const texts = (log: SqliteChatLog) =>
  historyPage(log, { limit: 100 }, { maxBytes: 2_000_000 }).items.map((i) => (i.type === "user" || i.type === "assistant" ? `${i.type}:${i.text}` : i.type));

describe("importPiChat", () => {
  test("imports owner messages and replies in order, below every live row, and renders them like live ones", async () => {
    const h = setup();
    h.log.append("user", { key: CLIENT, text: "live", uploadIds: [], at: at(100) }, CLIENT);
    const out = await importPiChat({ db: h.db, log: h.log, source: source([u(1), a(2), u(3), a(4)], { pageSize: 3 }), now: h.now });
    expect(out).toEqual({ imported: 4, skipped: 0 });
    expect(texts(h.log)).toEqual(["user:question 1", "assistant:answer 2", "user:question 3", "assistant:answer 4", "user:live"]);
    const [first, second] = historyPage(h.log, { limit: 100 }, { maxBytes: 2_000_000 }).items;
    expect(first).toEqual({ type: "user", id: expect.any(String), at: at(1), text: "question 1", attachments: [] });
    expect(second).toEqual({ type: "assistant", id: expect.any(String), at: at(2), text: "answer 2", outboxId: "pi:s:a2", tools: [], files: [] });
    expect(h.db.query("SELECT value FROM kv WHERE key = ?").get(IMPORT_DONE_KEY)).not.toBeNull();
  });

  test("only items older than the first live row are taken, and none the bot already has under its own key", async () => {
    const h = setup();
    h.advance(-10 * 86_400_000 + 50 * 60_000); // the first live row lands at minute 50
    h.log.append("reply", { key: "o1", text: "delivered", files: [] }, "o1");
    h.log.append("user", { key: CLIENT, text: "sent", uploadIds: [], at: at(49) }, CLIENT);
    const items = [u(10), a(20, { outboxId: "o1" }), u(30, { clientId: CLIENT }), a(40), u(60), a(70), { ...u(5), at: "not a time" }];
    await importPiChat({ db: h.db, log: h.log, source: source(items), now: h.now });
    expect(texts(h.log)).toEqual(["user:question 10", "assistant:answer 40", "assistant:delivered", "user:sent"]);
  });

  test("a rerun after it finished never calls the workspace", async () => {
    const h = setup();
    const src = source([u(1), a(2)]);
    await importPiChat({ db: h.db, log: h.log, source: src, now: h.now });
    expect(await importPiChat({ db: h.db, log: h.log, source: src, now: h.now })).toBeNull();
    expect(src.calls()).toBe(1);
    expect(texts(h.log)).toEqual(["user:question 1", "assistant:answer 2"]);
  });

  test("a crash midway leaves the committed pages and no done mark; the rerun resumes in order without duplicates", async () => {
    const h = setup();
    const items = [u(1), a(2), u(3), a(4), u(5), a(6)];
    await expect(importPiChat({ db: h.db, log: h.log, source: source(items, { pageSize: 2, failOn: (n) => n === 2 }), now: h.now })).rejects.toThrow("link dropped");
    expect(texts(h.log)).toEqual(["user:question 5", "assistant:answer 6"]);
    expect(h.db.query("SELECT value FROM kv WHERE key = ?").get(IMPORT_DONE_KEY)).toBeNull();
    expect(h.db.query("SELECT value FROM kv WHERE key = ?").get(IMPORT_CUTOFF_KEY)).not.toBeNull();

    expect(await importPiChat({ db: h.db, log: h.log, source: source(items, { pageSize: 2 }), now: h.now })).toEqual({ imported: 4, skipped: 0 });
    expect(texts(h.log)).toEqual(items.map((i) => (i.role === "user" ? `user:${i.text}` : `assistant:${i.text}`)));
  });

  test("the cutoff taken on the first attempt holds for a resumed one", async () => {
    const h = setup();
    const live = () => h.log.append("notice", { type: "nothingToStop" });
    await expect(importPiChat({ db: h.db, log: h.log, source: source([u(1)], { failOn: () => true }), now: h.now })).rejects.toThrow();
    // A live row older than "now" at the first attempt would otherwise pull the cutoff back before the reply.
    h.advance(-9 * 86_400_000);
    live();
    await importPiChat({ db: h.db, log: h.log, source: source([u(1), a(2 * 1440)]), now: h.now });
    expect(texts(h.log)).toEqual(["user:question 1", "assistant:answer 2880"]);
  });

  test("an empty history marks the import done", async () => {
    const h = setup();
    expect(await importPiChat({ db: h.db, log: h.log, source: source([]), now: h.now })).toEqual({ imported: 0, skipped: 0 });
    expect(h.db.query("SELECT value FROM kv WHERE key = ?").get(IMPORT_DONE_KEY)).not.toBeNull();
  });

  test("the message and byte caps keep the newest and count what they left out, the same way on a resumed run", async () => {
    const h = setup();
    const items = [u(1), a(2), u(3), a(4), u(5)];
    await expect(importPiChat({ db: h.db, log: h.log, source: source(items, { pageSize: 2, failOn: (n) => n === 2 }), now: h.now, maxMessages: 3 })).rejects.toThrow();
    expect(await importPiChat({ db: h.db, log: h.log, source: source(items, { pageSize: 2 }), now: h.now, maxMessages: 3 })).toEqual({ imported: 1, skipped: 2 });
    expect(texts(h.log)).toEqual(["user:question 3", "assistant:answer 4", "user:question 5"]);

    const b = setup();
    const big = [u(1, { text: "x".repeat(100) }), a(2, { text: "y".repeat(100) }), u(3, { text: "z".repeat(100) })];
    expect(await importPiChat({ db: b.db, log: b.log, source: source(big), now: b.now, maxBytes: 250 })).toEqual({ imported: 2, skipped: 1 });
    expect(texts(b.log).map((t) => t.slice(0, 12))).toEqual(["assistant:yy", "user:zzzzzzz"]);
  });

  test("workspace text is capped to the bot's own limits", async () => {
    const h = setup();
    await importPiChat({ db: h.db, log: h.log, source: source([u(1, { text: "q".repeat(20_000) })]), now: h.now });
    expect(h.log.find("user", "pi:s:u1")!.data.text).toEndWith("[truncated: 4000 more characters]");
  });
});

describe("createPiChatImporter", () => {
  test("a connect during a run joins it; a workspace without the method leaves it for the next connect", async () => {
    const h = setup();
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((r) => (release = r));
    const importer = createPiChatImporter({
      db: h.db,
      log: h.log,
      now: h.now,
      source: {
        async chatExport() {
          calls++;
          if (calls === 1) throw new RpcErrorReply("method not found: chat/export", -32601);
          await gate;
          return { items: [u(1)], before: null };
        },
      },
    });
    await importer.run();
    expect(h.db.query("SELECT value FROM kv WHERE key = ?").get(IMPORT_DONE_KEY)).toBeNull();
    const first = importer.run();
    const second = importer.run();
    expect(second).toBe(first);
    release();
    await first;
    expect(calls).toBe(2);
    expect(texts(h.log)).toEqual(["user:question 1"]);
    await importer.run();
    expect(calls).toBe(2);
  });
});
