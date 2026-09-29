import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatDeliverParams } from "../orchestration/contracts.ts";
import { writeFileAtomic } from "./files.ts";

type OutboxLine = { type: "entry"; entry: ChatDeliverParams } | { type: "ack"; outboxId: string };

// The agent can read the state dir; these would let it finish a pending sign-in with its own code.
const AUTH_URL_SECRET_PARAMS = ["state", "code_challenge", "nonce"];
const REDACTED_PARAM = "redacted";

/** The sign-in URL without the values that bind a callback to this login. */
export function redactAuthUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "about:blank";
  }
  for (const name of AUTH_URL_SECRET_PARAMS) if (parsed.searchParams.has(name)) parsed.searchParams.set(name, REDACTED_PARAM);
  return parsed.toString();
}

/** A sign-in link is written to disk redacted; only the in-memory copy can be resent. */
function onDisk(entry: ChatDeliverParams): ChatDeliverParams {
  return entry.auth ? { ...entry, auth: { ...entry.auth, url: redactAuthUrl(entry.auth.url) } } : entry;
}

/** Append-only JSONL of deliveries (entry before send, ack on confirm), compacted on load. A sign-in link
 *  left unacked by a previous process is dropped on load: its login died with that process. */
export class Outbox {
  readonly path: string;
  private readonly pending = new Map<string, ChatDeliverParams>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "outbox.jsonl");
    this.load();
  }

  append(entry: ChatDeliverParams): void {
    this.write({ type: "entry", entry: onDisk(entry) });
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
      if (line.type === "entry") {
        if (line.entry.kind !== "auth") this.pending.set(line.entry.outboxId, line.entry);
      }
      else if (line.type === "ack") this.pending.delete(line.outboxId);
    }
    const compacted = this.unacked().map((entry) => `${JSON.stringify({ type: "entry", entry } satisfies OutboxLine)}\n`);
    writeFileAtomic(this.path, compacted.join(""));
  }
}
