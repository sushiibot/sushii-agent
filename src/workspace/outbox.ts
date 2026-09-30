import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DELIVER_FILES_TOTAL_MAX_BYTES, type ChatDeliverParams, type DeliverFile } from "../orchestration/contracts.ts";
import { getLogger } from "../logger.ts";
import { writeFileAtomic } from "./files.ts";

const log = getLogger("workspace.outbox");

/** A file snapshotted for a delivery: the outbox keeps where it is, never its bytes. */
export interface StagedFile {
  name: string;
  contentType: string;
  /** Relative to the outbox's file store. */
  file: string;
  bytes: number;
  /** Checked at each send: the agent can reach the store, so a swapped copy must not go out. */
  sha256: string;
}

/** A delivery as the outbox holds it; `wire()` turns it into the chat/deliver params. */
export type OutboxEntry = Omit<ChatDeliverParams, "files"> & { stagedFiles?: StagedFile[] };

type OutboxLine = { type: "entry"; entry: OutboxEntry } | { type: "ack"; outboxId: string };

// The agent can read the state dir; these would let it finish a pending sign-in with its own code.
const AUTH_URL_SECRET_PARAMS = ["state", "code_challenge", "nonce"];
const REDACTED_PARAM = "redacted";
export const OUTBOX_FILES_DIR = "outbox-files";
// Under the bot's 16 MiB WebSocket frame cap: an oversized frame closes the link, and the resend after
// reconnect would close it again.
export const WIRE_MAX_BYTES = 15.5 * 1024 * 1024;

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

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Append-only JSONL of deliveries (entry before send, ack on confirm), compacted on load. A sign-in link
 *  left unacked by a previous process is dropped on load: its login died with that process.
 *  Files are written into `outbox-files/` when staged and read back (and hash-checked) at each send, so the
 *  JSONL holds only their names; an ack deletes them, and a load sweeps any that no pending entry references. */
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

  /** Writes `data` into the outbox's file store; throws when it is over `maxBytes`. */
  stage(data: Buffer, name: string, contentType: string, maxBytes: number): StagedFile {
    if (data.length > maxBytes) throw new Error(`${data.length} bytes is over the ${maxBytes}-byte limit`);
    mkdirSync(this.filesDir, { recursive: true });
    const file = `${randomUUID()}-${name}`;
    writeFileSync(join(this.filesDir, file), data);
    return { name, contentType, file, bytes: data.length, sha256: sha256(data) };
  }

  discard(files: StagedFile[]): void {
    for (const f of files) rmSync(join(this.filesDir, f.file), { force: true });
  }

  /** The chat/deliver params for `entry`, its staged files read back in. A file that is gone or no longer
   *  matches what was staged is left out and noted in the text. */
  wire(entry: OutboxEntry): ChatDeliverParams {
    const { stagedFiles, ...params } = entry;
    if (!stagedFiles?.length) return params;
    const files: DeliverFile[] = [];
    const missing: string[] = [];
    let total = 0;
    for (const f of stagedFiles) {
      let data: Buffer;
      try {
        data = readFileSync(join(this.filesDir, f.file));
      } catch {
        missing.push(f.name);
        continue;
      }
      if (data.length !== f.bytes || sha256(data) !== f.sha256) {
        log.warn({ outboxId: entry.outboxId, name: f.name }, "a staged outbox file changed after it was staged; leaving it out");
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
    const withFiles = { ...params, ...(files.length ? { files } : {}) };
    if (files.length && Buffer.byteLength(JSON.stringify(withFiles)) > WIRE_MAX_BYTES) {
      missing.push(...files.map((f) => f.name));
      files.length = 0;
    }
    if (missing.length) log.warn({ outboxId: entry.outboxId, missing }, "outbox files left out of a delivery");
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
    const kept = new Set(this.unacked().flatMap((e) => (e.stagedFiles ?? []).map((f) => f.file)));
    for (const name of readdirSync(this.filesDir)) {
      if (!kept.has(name)) rmSync(join(this.filesDir, name), { recursive: true, force: true });
    }
  }
}
