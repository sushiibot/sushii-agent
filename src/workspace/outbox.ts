import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DELIVER_FILES_TOTAL_MAX_BYTES, type ChatDeliverParams, type DeliverFile } from "../orchestration/contracts.ts";
import { getLogger } from "../logger.ts";
import { writeFileAtomic } from "./files.ts";

const log = getLogger("workspace.outbox");

/** A file snapshotted for a delivery: the outbox keeps its path, never its bytes. */
export interface StagedFile {
  name: string;
  contentType: string;
  path: string;
  bytes: number;
}

/** A delivery as the outbox holds it; `wire()` turns it into the chat/deliver params. */
export type OutboxEntry = Omit<ChatDeliverParams, "files"> & { stagedFiles?: StagedFile[] };

type OutboxLine = { type: "entry"; entry: OutboxEntry } | { type: "ack"; outboxId: string };

// The agent can read the state dir; these would let it finish a pending sign-in with its own code.
const AUTH_URL_SECRET_PARAMS = ["state", "code_challenge", "nonce"];
const REDACTED_PARAM = "redacted";
export const OUTBOX_FILES_DIR = "outbox-files";

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
function onDisk(entry: OutboxEntry): OutboxEntry {
  return entry.auth ? { ...entry, auth: { ...entry.auth, url: redactAuthUrl(entry.auth.url) } } : entry;
}

/** Append-only JSONL of deliveries (entry before send, ack on confirm), compacted on load. A sign-in link
 *  left unacked by a previous process is dropped on load: its login died with that process.
 *  Files are copied into `outbox-files/` when staged and read back at each send, so the JSONL holds only
 *  their paths; an ack deletes them, and a load sweeps any that no pending entry references. */
export class Outbox {
  readonly path: string;
  readonly filesDir: string;
  private readonly pending = new Map<string, OutboxEntry>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "outbox.jsonl");
    this.filesDir = join(stateDir, OUTBOX_FILES_DIR);
    this.load();
  }

  append(entry: OutboxEntry): void {
    this.write({ type: "entry", entry: onDisk(entry) });
    this.pending.set(entry.outboxId, entry);
  }

  /** False when the id was unknown or already acked. */
  ack(outboxId: string): boolean {
    const entry = this.pending.get(outboxId);
    if (!entry) return false;
    this.write({ type: "ack", outboxId });
    this.pending.delete(outboxId);
    this.discard(entry.stagedFiles ?? []);
    return true;
  }

  /** Unacked entries in the order they were appended. */
  unacked(): OutboxEntry[] {
    return [...this.pending.values()];
  }

  /** Copies `source` into the outbox's file store; throws when it isn't a regular file of at most `maxBytes`. */
  stage(source: string, name: string, contentType: string, maxBytes: number): StagedFile {
    const before = statSync(source);
    if (!before.isFile()) throw new Error("not a regular file");
    if (before.size > maxBytes) throw new Error(`${before.size} bytes is over the ${maxBytes}-byte limit`);
    mkdirSync(this.filesDir, { recursive: true });
    const path = join(this.filesDir, `${randomUUID()}-${name}`);
    copyFileSync(source, path);
    // The source can grow between the stat and the copy.
    const bytes = statSync(path).size;
    if (bytes > maxBytes) {
      rmSync(path, { force: true });
      throw new Error(`${bytes} bytes is over the ${maxBytes}-byte limit`);
    }
    return { name, contentType, path, bytes };
  }

  discard(files: StagedFile[]): void {
    for (const f of files) rmSync(f.path, { force: true });
  }

  /** The chat/deliver params for `entry`, its staged files read back in. A file that is gone is left out
   *  and noted in the text. */
  wire(entry: OutboxEntry): ChatDeliverParams {
    const { stagedFiles, ...params } = entry;
    if (!stagedFiles?.length) return params;
    const files: DeliverFile[] = [];
    const missing: string[] = [];
    let total = 0;
    for (const f of stagedFiles) {
      let data: Buffer;
      try {
        data = readFileSync(f.path);
      } catch {
        missing.push(f.name);
        continue;
      }
      if (total + data.length > DELIVER_FILES_TOTAL_MAX_BYTES) {
        missing.push(f.name);
        continue;
      }
      total += data.length;
      files.push({ name: f.name, contentType: f.contentType, dataBase64: data.toString("base64") });
    }
    if (missing.length) log.warn({ outboxId: entry.outboxId, missing }, "outbox files missing at send");
    const note = missing.length ? `\n-# (couldn't attach: ${missing.join(", ")})` : "";
    return { ...params, text: `${params.text}${note}`, ...(files.length ? { files } : {}) };
  }

  private write(line: OutboxLine): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  private load(): void {
    if (existsSync(this.path)) {
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
    this.sweepFiles();
  }

  private sweepFiles(): void {
    if (!existsSync(this.filesDir)) return;
    const kept = new Set(this.unacked().flatMap((e) => (e.stagedFiles ?? []).map((f) => f.path)));
    for (const name of readdirSync(this.filesDir)) {
      const path = join(this.filesDir, name);
      if (!kept.has(path)) rmSync(path, { recursive: true, force: true });
    }
  }
}
