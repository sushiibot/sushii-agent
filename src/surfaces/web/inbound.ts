import type { Database } from "bun:sqlite";
import { INBOUND_RETENTION_MS } from "./chatLog.ts";

export interface InboundRow {
  clientId: string;
  text: string;
  uploadIds: string[];
  seq: number;
  createdAt: number;
  routedAt: number | null;
}

type Raw = { client_id: string; text: string; upload_ids: string; seq: number; created_at: number; routed_at: number | null };

/** web_inbound: each owner message, persisted before its 202 and routed until the workspace gives a receipt. */
export class WebInboundStore {
  constructor(private readonly db: Database) {}

  get(clientId: string): InboundRow | null {
    const r = this.db.query("SELECT * FROM web_inbound WHERE client_id = ?").get(clientId) as Raw | null;
    return r ? { clientId: r.client_id, text: r.text, uploadIds: JSON.parse(r.upload_ids), seq: r.seq, createdAt: r.created_at, routedAt: r.routed_at } : null;
  }

  insert(row: Omit<InboundRow, "routedAt">): void {
    this.db.run("INSERT INTO web_inbound (client_id, text, upload_ids, seq, created_at) VALUES (?, ?, ?, ?, ?)", [
      row.clientId,
      row.text,
      JSON.stringify(row.uploadIds),
      row.seq,
      row.createdAt,
    ]);
  }

  markRouted(clientId: string, now: number): void {
    this.db.run("UPDATE web_inbound SET routed_at = ? WHERE client_id = ? AND routed_at IS NULL", [now, clientId]);
  }

  prune(now: number): void {
    this.db.run("DELETE FROM web_inbound WHERE created_at < ?", [now - INBOUND_RETENTION_MS]);
  }
}
