import type { Database, Statement } from "bun:sqlite";
import { getLogger } from "../../logger.ts";
import type { ChatEnvelope, ChatEventMap, DurableEventType, EphemeralEventType, PendingState } from "./events.ts";

const log = getLogger("web/chatLog");

export const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENTS_MAX_ROWS = 50_000;
export const INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNED_THROUGH_KEY = "web_events:pruned_through";
/** The chat itself, kept forever: neither the age prune nor the row cap ever deletes these. */
export const PERMANENT_EVENTS = ["user", "reply", "proactive", "ask", "ask_resolved", "approval", "approval_resolved", "session", "alert"] as const satisfies readonly DurableEventType[];
const PRUNABLE = `type NOT IN (${PERMANENT_EVENTS.map((t) => `'${t}'`).join(",")})`;

/** A row for `prepend`, its data typed by its event type. */
export type PrependRow = { [T in DurableEventType]: { type: T; key: string; data: ChatEventMap[T]; createdAt: number } }[DurableEventType];

/** Full-text index of the chat text; best-effort, so it never throws into a chat write. */
export interface ChatTextIndex {
  add(seq: number, text: string): void;
}

export type EphemeralEnvelope = Extract<ChatEnvelope, { type: EphemeralEventType }>;
export type ChatSink = (ev: ChatEnvelope) => void;

export interface Subscription {
  close(): void;
  head: number;
  /** `after` is outside the retained range: nothing was replayed and the client must reload history. */
  reset: boolean;
}

/** Transport seam: SSE (and any later transport) only encodes what this emits. */
export interface ChatLog {
  /** Idempotent on (type, key): a repeat returns the existing seq and is not fanned out again. */
  append<T extends DurableEventType>(type: T, data: ChatEventMap[T], key?: string): number;
  publish(ev: EphemeralEnvelope): void;
  /** Replays events with seq > `after` into `sink` synchronously, then streams live ones. `after` null
   *  replays nothing. */
  subscribe(after: number | null, sink: ChatSink): Subscription;
  prune(now: number): void;
}

export interface StoredEvent<T extends DurableEventType = DurableEventType> {
  seq: number;
  type: T;
  key: string | null;
  data: ChatEventMap[T];
  createdAt: number;
}

/** A row's place in history: its sort seq (its own seq unless set), then its seq. */
export interface HistoryPosition {
  order: number;
  seq: number;
}

type Row = { seq: number; type: string; key: string | null; data: string; created_at: number };

function toStored(row: Row): StoredEvent {
  return { seq: row.seq, type: row.type as DurableEventType, key: row.key, data: JSON.parse(row.data), createdAt: row.created_at };
}

function toEnvelope(ev: StoredEvent): ChatEnvelope {
  return { seq: ev.seq, type: ev.type, data: ev.data } as ChatEnvelope;
}

export function pageQuery(types: readonly string[], opts: { before?: HistoryPosition; limit: number }): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [...types];
  // Without statistics the planner picks the (type, key) index and sorts every chat row; this walks the order.
  let sql = `SELECT seq, type, key, data, created_at, coalesce(sort_seq, seq) AS ord FROM web_events INDEXED BY idx_web_events_order WHERE type IN (${types.map(() => "?").join(",")})`;
  if (opts.before !== undefined) {
    // The plain bound is what lets the index seek; the planner can't range-scan the row value alone.
    sql += " AND coalesce(sort_seq, seq) <= ? AND (coalesce(sort_seq, seq), seq) < (?, ?)";
    params.push(opts.before.order, opts.before.order, opts.before.seq);
  }
  sql += " ORDER BY coalesce(sort_seq, seq) DESC, seq DESC LIMIT ?";
  params.push(opts.limit);
  return { sql, params };
}

export class SqliteChatLog implements ChatLog {
  readonly conversationId: string;
  private readonly scope: string;
  private readonly sinks = new Set<ChatSink>();
  private batch: ChatEnvelope[] | null = null;
  private readonly now: () => number;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private readonly index: ChatTextIndex | undefined;
  private readonly q: {
    byKey: Statement<Row, [string, string]>;
    insert: Statement<{ seq: number }, [string, string | null, string, number, number | null]>;
    after: Statement<Row, [number]>;
    min: Statement<{ m: number | null }, []>;
    head: Statement<{ seq: number }, []>;
    prunedThrough: Statement<{ value: string }, [string]>;
    anchor: Statement<unknown, [string, number, number]>;
    anchorOf: Statement<{ a: number }, [string]>;
  };

  constructor(
    private readonly db: Database,
    opts: { now?: () => number; maxRows?: number; retentionMs?: number; index?: ChatTextIndex; conversationId?: string } = {},
  ) {
    this.conversationId = opts.conversationId ?? "main";
    this.scope = `conversation_id = '${this.conversationId.replaceAll("'", "''")}'`;
    this.now = opts.now ?? Date.now;
    this.index = opts.index;
    this.maxRows = opts.maxRows ?? EVENTS_MAX_ROWS;
    this.retentionMs = opts.retentionMs ?? EVENTS_RETENTION_MS;
    this.q = {
      byKey: this.db.query(`SELECT seq, type, key, data, created_at FROM web_events WHERE ${this.scope} AND type = ? AND key = ?`),
      insert: this.db.query(`INSERT INTO web_events (conversation_id, type, key, data, created_at, sort_seq) VALUES ('${this.conversationId.replaceAll("'", "''")}', ?, ?, ?, ?, ?) RETURNING seq`),
      after: this.db.query(`SELECT seq, type, key, data, created_at FROM web_events WHERE ${this.scope} AND seq > ? ORDER BY seq`),
      // Imported rows sit at seq <= 0, below anything a stream can resume from.
      min: this.db.query("SELECT min(seq) AS m FROM web_events WHERE seq > 0"),
      head: this.db.query("SELECT seq FROM sqlite_sequence WHERE name = 'web_events'"),
      prunedThrough: this.db.query("SELECT value FROM kv WHERE key = ?"),
      anchor: this.db.query("INSERT OR IGNORE INTO web_turn_anchors (turn_id, anchor_seq, created_at) VALUES (?, ?, ?)"),
      anchorOf: this.db.query("SELECT anchor_seq AS a FROM web_turn_anchors WHERE turn_id = ?"),
    };
  }

  append<T extends DurableEventType>(type: T, data: ChatEventMap[T], key?: string): number {
    return this.appendResult(type, data, key).seq;
  }

  /** `sortSeq` places the row in history as if it came right after that seq; SSE replay still follows seq. */
  appendResult<T extends DurableEventType>(type: T, data: ChatEventMap[T], key?: string, sortSeq?: number): { seq: number; created: boolean } {
    const json = JSON.stringify(data);
    const res = this.db.transaction(() => {
      if (key !== undefined) {
        const existing = this.q.byKey.get(type, key);
        if (existing) {
          if (existing.data !== json) log.warn({ type, seq: existing.seq }, "dropped a duplicate web event whose content differs from the stored one");
          return { seq: existing.seq, created: false };
        }
      }
      return { seq: this.q.insert.get(type, key ?? null, json, this.now(), sortSeq ?? null)!.seq, created: true };
    })();
    if (res.created) {
      if (this.index && (type === "user" || type === "reply" || type === "proactive" || type === "alert")) this.index.add(res.seq, (data as ChatEventMap["user"]).text);
      this.fanOut({ seq: res.seq, type, data } as ChatEnvelope);
    }
    return res;
  }

  /** Inside `fn`, appends commit together or not at all, and are fanned out only after the commit. */
  transaction<R>(fn: () => R): R {
    if (this.batch) return fn();
    this.batch = [];
    try {
      const out = this.db.transaction(fn)();
      const committed = this.batch;
      this.batch = null;
      for (const ev of committed) this.fanOut(ev);
      return out;
    } finally {
      this.batch = null;
    }
  }

  publish(ev: EphemeralEnvelope): void {
    this.fanOut(ev);
  }

  subscribe(after: number | null, sink: ChatSink): Subscription {
    const head = this.head();
    let reset = false;
    if (after !== null) {
      const min = this.q.min.get()?.m ?? null;
      // A pruned seq above `after`, or a cursor from another database, leaves a gap replay can't fill.
      reset = after > head || after < this.prunedThrough() || (min === null ? after < head : after < min - 1);
      if (!reset) for (const row of this.q.after.all(after)) sink(toEnvelope(toStored(row)));
    }
    this.sinks.add(sink);
    return { head, reset, close: () => void this.sinks.delete(sink) };
  }

  head(): number {
    return this.q.head.get()?.seq ?? 0;
  }

  find<T extends DurableEventType>(type: T, key: string): StoredEvent<T> | null {
    const row = this.q.byKey.get(type, key);
    return row ? (toStored(row) as StoredEvent<T>) : null;
  }

  /** The highest seq a prune has deleted; rows the cap exempts can sit below it, so `min(seq)` can't tell. */
  prunedThrough(): number {
    return Number(this.q.prunedThrough.get(`${PRUNED_THROUGH_KEY}:${this.conversationId}`)?.value ?? (this.conversationId === "main" ? this.q.prunedThrough.get(PRUNED_THROUGH_KEY)?.value : undefined) ?? 0);
  }

  /** Approvals created since `approvalsSince` with no decision, and the newest `asks` unanswered asks. */
  pending(opts: { approvalsSince: number; asks: number }): PendingState {
    const approvals = this.db
      .query(
        `SELECT seq, type, key, data, created_at FROM web_events e WHERE e.${this.scope} AND e.type = 'approval' AND e.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM web_events r WHERE r.conversation_id = e.conversation_id AND r.type = 'approval_resolved' AND r.key = e.key) ORDER BY seq`,
      )
      .all(opts.approvalsSince) as Row[];
    const asks = this.db
      .query(
        `SELECT seq, type, key, data, created_at FROM web_events e WHERE e.${this.scope} AND e.type = 'ask' AND json_extract(e.data, '$.askId') != ''
         AND NOT EXISTS (SELECT 1 FROM web_events r WHERE r.conversation_id = e.conversation_id AND r.type = 'ask_resolved' AND r.key = json_extract(e.data, '$.askId')) ORDER BY seq DESC LIMIT ?`,
      )
      .all(opts.asks) as Row[];
    const at = (r: Row) => new Date(r.created_at).toISOString();
    return {
      approvals: approvals.map((r) => {
        const d = JSON.parse(r.data) as ChatEventMap["approval"];
        return { seq: r.seq, at: at(r), nonce: d.nonce, view: d.view };
      }),
      asks: asks.reverse().map((r) => {
        const d = JSON.parse(r.data) as ChatEventMap["ask"];
        return { seq: r.seq, at: at(r), key: d.key, askId: d.askId, question: d.question, choices: d.choices };
      }),
    };
  }

  /** Marks every undecided approval cancelled. Only for boot: the previous process's pending approvals
   *  died with it, so none of them can be decided any more. Returns how many it cancelled. */
  cancelUnresolvedApprovals(): number {
    const rows = this.db
      .query(`SELECT key FROM web_events e WHERE e.${this.scope} AND e.type = 'approval' AND e.key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM web_events r WHERE r.conversation_id = e.conversation_id AND r.type = 'approval_resolved' AND r.key = e.key) ORDER BY seq`)
      .all() as { key: string }[];
    this.transaction(() => {
      for (const { key } of rows) this.append("approval_resolved", { nonce: key, decision: "cancelled" }, key);
    });
    return rows.length;
  }

  findAsk(askId: string): StoredEvent<"ask"> | null {
    const row = this.db
      .query(`SELECT seq, type, key, data, created_at FROM web_events WHERE ${this.scope} AND type = 'ask' AND json_extract(data, '$.askId') = ? ORDER BY seq DESC LIMIT 1`)
      .get(askId) as Row | null;
    return row ? (toStored(row) as StoredEvent<"ask">) : null;
  }

  /** Records the chat head as `turnId`'s start, once; a reply for the turn sorts there. */
  anchorTurn(turnId: string): void {
    this.q.anchor.run(turnId, this.head(), this.now());
  }

  turnAnchor(turnId: string): number | null {
    return this.q.anchorOf.get(turnId)?.a ?? null;
  }

  /** The newest `limit` events of `types` in history order below the `before` position, newest first. */
  page<T extends DurableEventType>(types: readonly T[], opts: { before?: HistoryPosition; limit: number }): (StoredEvent<T> & { order: number })[] {
    const query = pageQuery(types, opts);
    const sql = query.sql.replace("WHERE type", `WHERE ${this.scope} AND type`).replace("INDEXED BY idx_web_events_order", "INDEXED BY idx_web_events_conversation_order");
    const params = query.params;
    return (this.db.query(sql).all(...params) as (Row & { ord: number })[]).map((r) => ({ ...(toStored(r) as StoredEvent<T>), order: r.ord }));
  }

  list<T extends DurableEventType>(types: readonly T[], opts: { keys?: readonly string[]; since?: number } = {}): StoredEvent<T>[] {
    if (!types.length || (opts.keys && !opts.keys.length)) return [];
    const params: (string | number)[] = [...types];
    let sql = `SELECT seq, type, key, data, created_at FROM web_events WHERE ${this.scope} AND type IN (${types.map(() => "?").join(",")})`;
    if (opts.keys) {
      sql += ` AND key IN (${opts.keys.map(() => "?").join(",")})`;
      params.push(...opts.keys);
    }
    if (opts.since !== undefined) {
      sql += " AND created_at >= ?";
      params.push(opts.since);
    }
    sql += " ORDER BY seq";
    return (this.db.query(sql).all(...params) as Row[]).map((r) => toStored(r) as StoredEvent<T>);
  }

  /** The oldest live row's time, or null when there is none. Imported rows don't count. */
  firstLiveAt(): number | null {
    return (this.db.query(`SELECT min(created_at) AS m FROM web_events WHERE ${this.scope} AND seq > 0`).get() as { m: number | null }).m;
  }

  /** Stores rows below every seq already held, in the order given (newest first), without fanning them out.
   *  A (type, key) already stored is skipped. Returns how many were stored. */
  prepend(rows: readonly PrependRow[]): number {
    return this.db.transaction(() => {
      let next = Math.min((this.db.query("SELECT min(seq) AS m FROM web_events").get() as { m: number | null }).m ?? 1, 1) - 1;
      let stored = 0;
      for (const r of rows) {
        if (this.q.byKey.get(r.type, r.key)) continue;
        this.db.run("INSERT INTO web_events (seq, type, key, data, created_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?)", [next--, r.type, r.key, JSON.stringify(r.data), r.createdAt, this.conversationId]);
        stored++;
      }
      return stored;
    })();
  }

  prune(now: number): void {
    this.db.transaction(() => {
      const aged = this.db.query(`DELETE FROM web_events WHERE ${this.scope} AND created_at < ? AND ${PRUNABLE} RETURNING seq`).all(now - this.retentionMs) as { seq: number }[];
      const evicted = this.db
        .query(`DELETE FROM web_events WHERE ${this.scope} AND seq IN (SELECT seq FROM web_events WHERE ${this.scope} AND ${PRUNABLE} ORDER BY seq DESC LIMIT -1 OFFSET ?) RETURNING seq`)
        .all(this.maxRows) as { seq: number }[];
      this.db.run("DELETE FROM web_turn_anchors WHERE created_at < ?", [now - this.retentionMs]);
      const through = Math.max(this.prunedThrough(), ...aged.map((r) => r.seq), ...evicted.map((r) => r.seq));
      if (through > this.prunedThrough()) {
        this.db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`${PRUNED_THROUGH_KEY}:${this.conversationId}`, String(through)]);
      }
    })();
  }

  get subscribers(): number {
    return this.sinks.size;
  }

  private fanOut(ev: ChatEnvelope): void {
    if (this.batch) {
      this.batch.push(ev);
      return;
    }
    for (const sink of [...this.sinks]) {
      try {
        sink(ev);
      } catch (err) {
        log.warn({ err, type: ev.type }, "chat sink threw; dropping it");
        this.sinks.delete(sink);
      }
    }
  }
}
