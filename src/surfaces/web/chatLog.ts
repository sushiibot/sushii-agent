import type { Database, Statement } from "bun:sqlite";
import { getLogger } from "../../logger.ts";
import type { ChatEnvelope, ChatEventMap, DurableEventType, EphemeralEventType } from "./events.ts";

const log = getLogger("web/chatLog");

export const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENTS_MAX_ROWS = 50_000;
export const INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type EphemeralEnvelope = Extract<ChatEnvelope, { type: EphemeralEventType }>;
export type ChatSink = (ev: ChatEnvelope) => void;

export interface Subscription {
  close(): void;
  /** The newest seq ever issued. */
  head: number;
  /** `after` is outside the retained range: nothing was replayed and the client must reload history. */
  reset: boolean;
}

/** Transport seam: SSE (and any later transport) only encodes what this emits. */
export interface ChatLog {
  /** Idempotent on (type, key): a repeat returns the existing seq and is not fanned out again. */
  append<T extends DurableEventType>(type: T, data: ChatEventMap[T], key?: string): number;
  /** Ephemeral fan-out to open subscriptions; never stored. */
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

type Row = { seq: number; type: string; key: string | null; data: string; created_at: number };

function toStored(row: Row): StoredEvent {
  return { seq: row.seq, type: row.type as DurableEventType, key: row.key, data: JSON.parse(row.data), createdAt: row.created_at };
}

function toEnvelope(ev: StoredEvent): ChatEnvelope {
  return { seq: ev.seq, type: ev.type, data: ev.data } as ChatEnvelope;
}

export class SqliteChatLog implements ChatLog {
  private readonly sinks = new Set<ChatSink>();
  private batch: ChatEnvelope[] | null = null;
  private readonly now: () => number;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private readonly q: {
    byKey: Statement<Row, [string, string]>;
    insert: Statement<{ seq: number }, [string, string | null, string, number]>;
    after: Statement<Row, [number]>;
    min: Statement<{ m: number | null }, []>;
    head: Statement<{ seq: number }, []>;
  };

  constructor(
    private readonly db: Database,
    opts: { now?: () => number; maxRows?: number; retentionMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxRows = opts.maxRows ?? EVENTS_MAX_ROWS;
    this.retentionMs = opts.retentionMs ?? EVENTS_RETENTION_MS;
    this.q = {
      byKey: db.query("SELECT seq, type, key, data, created_at FROM web_events WHERE type = ? AND key = ?"),
      insert: db.query("INSERT INTO web_events (type, key, data, created_at) VALUES (?, ?, ?, ?) RETURNING seq"),
      after: db.query("SELECT seq, type, key, data, created_at FROM web_events WHERE seq > ? ORDER BY seq"),
      min: db.query("SELECT min(seq) AS m FROM web_events"),
      head: db.query("SELECT seq FROM sqlite_sequence WHERE name = 'web_events'"),
    };
  }

  append<T extends DurableEventType>(type: T, data: ChatEventMap[T], key?: string): number {
    return this.appendResult(type, data, key).seq;
  }

  /** As append, and whether this call stored the event. */
  appendResult<T extends DurableEventType>(type: T, data: ChatEventMap[T], key?: string): { seq: number; created: boolean } {
    const json = JSON.stringify(data);
    const res = this.db.transaction(() => {
      if (key !== undefined) {
        const existing = this.q.byKey.get(type, key);
        if (existing) {
          if (existing.data !== json) log.warn({ type, seq: existing.seq }, "dropped a duplicate web event whose content differs from the stored one");
          return { seq: existing.seq, created: false };
        }
      }
      return { seq: this.q.insert.get(type, key ?? null, json, this.now())!.seq, created: true };
    })();
    if (res.created) this.fanOut({ seq: res.seq, type, data } as ChatEnvelope);
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
      reset = after > head || (min === null ? after < head : after < min - 1);
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

  /** Stored events of the given types, oldest first. */
  list<T extends DurableEventType>(types: readonly T[], opts: { keys?: readonly string[]; since?: number } = {}): StoredEvent<T>[] {
    if (!types.length || (opts.keys && !opts.keys.length)) return [];
    const params: (string | number)[] = [...types];
    let sql = `SELECT seq, type, key, data, created_at FROM web_events WHERE type IN (${types.map(() => "?").join(",")})`;
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

  prune(now: number): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM web_events WHERE created_at < ?", [now - this.retentionMs]);
      this.db.run("DELETE FROM web_events WHERE seq IN (SELECT seq FROM web_events ORDER BY seq DESC LIMIT -1 OFFSET ?)", [this.maxRows]);
    })();
  }

  /** Open subscriptions; for tests and shutdown. */
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
