import type { Database } from "bun:sqlite";
import { INBOUND_RETENTION_MS } from "./chatLog.ts";

/** pending: not routed yet (never attempted, or the attempt was cut off); rejected: the connected workspace
 *  refused it, and only the owner's retry routes it again; discarded: the owner deleted it, so it is never routed. */
export type InboundState = "pending" | "routed" | "rejected" | "discarded";

export interface InboundRow {
  clientId: string;
  text: string;
  uploadIds: string[];
  seq: number;
  createdAt: number;
  routedAt: number | null;
  state: InboundState;
}

type Raw = { client_id: string; text: string; upload_ids: string; seq: number; created_at: number; routed_at: number | null; state: InboundState };

/** web_inbound: each owner message, persisted before its 202 and routed until the workspace gives a receipt. */
export class WebInboundStore {
  constructor(private readonly db: Database) {}

  get(clientId: string): InboundRow | null {
    const r = this.db.query("SELECT * FROM web_inbound WHERE client_id = ?").get(clientId) as Raw | null;
    return r ? toRow(r) : null;
  }

  /** Pending rows created at or after `since`, oldest first. */
  unrouted(since: number): InboundRow[] {
    return (this.db.query("SELECT * FROM web_inbound WHERE state = 'pending' AND created_at >= ? ORDER BY seq").all(since) as Raw[]).map(toRow);
  }

  insert(row: Omit<InboundRow, "routedAt" | "state">): void {
    this.db.run("INSERT INTO web_inbound (client_id, text, upload_ids, seq, created_at) VALUES (?, ?, ?, ?, ?)", [
      row.clientId,
      row.text,
      JSON.stringify(row.uploadIds),
      row.seq,
      row.createdAt,
    ]);
  }

  /** A discarded row stays discarded: the owner's delete wins over a late receipt. */
  markRouted(clientId: string, now: number): void {
    this.db.run("UPDATE web_inbound SET state = 'routed', routed_at = ? WHERE client_id = ? AND state IN ('pending', 'rejected')", [now, clientId]);
  }

  markRejected(clientId: string): void {
    this.db.run("UPDATE web_inbound SET state = 'rejected' WHERE client_id = ? AND state = 'pending'", [clientId]);
  }

  /** The owner's retry of a refused message. */
  markPending(clientId: string): void {
    this.db.run("UPDATE web_inbound SET state = 'pending' WHERE client_id = ? AND state = 'rejected'", [clientId]);
  }

  /** True when the row was pending or rejected and is now discarded. */
  discard(clientId: string): boolean {
    return this.db.run("UPDATE web_inbound SET state = 'discarded' WHERE client_id = ? AND state IN ('pending', 'rejected')", [clientId]).changes > 0;
  }

  /** Routed rows go INBOUND_RETENTION_MS after routing; the rest only once that old themselves. */
  prune(now: number): void {
    const cutoff = now - INBOUND_RETENTION_MS;
    this.db.run("DELETE FROM web_inbound WHERE (routed_at IS NOT NULL AND routed_at < ?) OR (routed_at IS NULL AND created_at < ?)", [cutoff, cutoff]);
  }
}

function toRow(r: Raw): InboundRow {
  return { clientId: r.client_id, text: r.text, uploadIds: JSON.parse(r.upload_ids), seq: r.seq, createdAt: r.created_at, routedAt: r.routed_at, state: r.state };
}
