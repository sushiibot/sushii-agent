import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatDeliverParams } from "../orchestration/contracts.ts";
import { writeFileAtomic } from "./files.ts";

type OutboxLine = { type: "entry"; entry: ChatDeliverParams } | { type: "ack"; outboxId: string };

/** Append-only JSONL of deliveries (entry before send, ack on confirm), compacted on load. */
export class Outbox {
  readonly path: string;
  private readonly pending = new Map<string, ChatDeliverParams>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "outbox.jsonl");
    this.load();
  }

  append(entry: ChatDeliverParams): void {
    this.write({ type: "entry", entry });
    this.pending.set(entry.outboxId, entry);
  }

  /** False when the id was unknown or already acked. */
  ack(outboxId: string): boolean {
    if (!this.pending.has(outboxId)) return false;
    this.write({ type: "ack", outboxId });
    this.pending.delete(outboxId);
    return true;
  }

  /** Unacked entries in the order they were appended. */
  unacked(): ChatDeliverParams[] {
    return [...this.pending.values()];
  }

  private write(line: OutboxLine): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    for (const raw of readFileSync(this.path, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let line: OutboxLine;
      try {
        line = JSON.parse(raw) as OutboxLine;
      } catch {
        continue; // a torn last line from a crash mid-append
      }
      if (line.type === "entry") this.pending.set(line.entry.outboxId, line.entry);
      else if (line.type === "ack") this.pending.delete(line.outboxId);
    }
    const compacted = this.unacked().map((entry) => `${JSON.stringify({ type: "entry", entry } satisfies OutboxLine)}\n`);
    writeFileAtomic(this.path, compacted.join(""));
  }
}
