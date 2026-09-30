import { constants, readdirSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { ID_MAX, RPC_METHODS, chatExportParams, type ChatDeliverParams, type ChatExportItem, type ChatExportResult, type ChatUsage } from "../orchestration/contracts.ts";
import { getLogger } from "../logger.ts";
import { isNoReply } from "./events.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { SESSION_DIRS } from "./sessionPaths.ts";
import { confineSessionFile, parseEntry, realRoots, textOf } from "./wsRuns.ts";

const log = getLogger("workspace.chatExport");

/**
 * The Main transcript's owner messages and final replies, read from the Pi session JSONL under
 * `<agentDir>/chat`, for the bot's one-time import into its own chat log.
 *
 * Chat sessions are made with `SessionManager.create(cwd, dir)`, which sets no `parentSession`, and Pi names
 * each file `<ISO timestamp>_<uuid>.jsonl` when it is created. The host holds one Main session at a time, so
 * name order is creation order.
 *
 * Paging: a page holds the newest `limit` items older than `before`, oldest first. `before` in the result is
 * the id of the page's oldest item, or null at the start of the transcript. Item ids are
 * `<sessionFileBase>:<entryId>`, so every id is also a cursor.
 */

/** Custom entry the host appends whenever it outboxes a delivery: the join key between the transcript and the bot's record. */
export const DELIVERY_ENTRY = "sushii.delivery";
/** Custom entry the host appends to a session it swaps in, naming why the previous one ended. */
export const SESSION_ENTRY = "sushii.session";

export interface DeliveryMarker {
  outboxId: string;
  kind: ChatDeliverParams["kind"];
  turnId?: string;
  /** Set when the delivered text isn't the turn's own assistant text (proactive, out-of-band, a failure notice). */
  text?: string;
  usage?: ChatUsage;
  ask?: { askId: string; question: string; choices: string[] };
}

export interface SessionMarker {
  reason: "new" | "rotated";
}

export const EXPORT_MAX_BYTES = 2_000_000;
const ITEM_TEXT_MAX = 100_000;
const CACHE_FILES = 8;

const HEADER_RE = /^\[([A-Za-z]+):(\S+) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC(?:, voice message, transcribed)?\]$/;
const VOICE_ONLY = "[voice message, transcribed]";
const ATTACHMENT_RE = /^\[attachment: (.*) \(([^()]*)\) (\S+)(?: → \S+)?\]$/;
const IMAGE_NOTE_RE = /^\[Image(?: omitted)?: .*\]$/;

/** Thrown when `before` names no item the reader still has. */
export class ExportCursorError extends Error {
  constructor() {
    super("unknown export cursor");
  }
}

interface RawEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown; stopReason?: string };
}

/** An entry cut down to what the conversion reads: no image data, no tool calls, no tool output. */
interface SlimEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; text: string; stopReason?: string };
}

const str = (v: unknown): v is string => typeof v === "string";
const idOf = (v: unknown): string | undefined => (str(v) && v.length > 0 && v.length <= ID_MAX ? v : undefined);
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function slim(e: RawEntry & { id: string }): SlimEntry {
  const out: SlimEntry = { type: str(e.type) ? e.type : "", id: e.id, parentId: str(e.parentId) ? e.parentId : null };
  if (str(e.timestamp)) out.timestamp = e.timestamp;
  if (str(e.customType)) out.customType = e.customType;
  if (e.type === "custom" && e.customType === DELIVERY_ENTRY) out.data = e.data;
  if (e.type === "message" && e.message) {
    const m = e.message;
    out.message = {
      ...(str(m.role) ? { role: m.role } : {}),
      text: m.role === "user" || m.role === "assistant" ? textOf(m.content) : "",
      ...(str(m.stopReason) ? { stopReason: m.stopReason } : {}),
    };
  }
  return out;
}

/** A session file's entries as they are appended, indexed so the branch can be re-derived after each append. */
class SessionIndex {
  private readonly byId = new Map<string, SlimEntry>();
  private leaf: string | null = null;
  private lines = 0;

  /** One JSONL line; a line that doesn't parse (a torn write) is skipped. Throws when the file doesn't open with a session header. */
  add(line: string): void {
    const e = parseEntry(line) as RawEntry | null;
    if (this.lines++ === 0 && e?.type !== "session") throw new Error("not a session file");
    if (!e) return;
    if (e.type === "session" || !str(e.id)) return;
    this.byId.set(e.id, slim(e as RawEntry & { id: string }));
    this.leaf = e.id;
  }

  /** The entries on the path from the last entry back to the root, root first (Pi's own leaf rule). */
  branch(): SlimEntry[] {
    const path: SlimEntry[] = [];
    const seen = new Set<string>();
    for (let e = this.leaf ? this.byId.get(this.leaf) : undefined; e && !seen.has(e.id); e = e.parentId ? this.byId.get(e.parentId) : undefined) {
      seen.add(e.id);
      path.push(e);
    }
    return path.reverse();
  }
}

interface FileState {
  dev: number;
  ino: number;
  /** Bytes consumed, up to and including the last complete line. */
  offset: number;
  /** The bytes just before `offset`, compared before each incremental read so an in-place rewrite forces a full re-parse. */
  tail: Buffer;
  index: SessionIndex;
  size: number;
  mtimeMs: number;
  result: ChatExportItem[] | null;
}

const READ_CHUNK = 1024 * 1024;
const TAIL_BYTES = 256;

export type OpenFile = (path: string, flags: number) => Promise<FileHandle>;

export class ChatExportReader {
  private readonly cache = new Map<string, FileState>();
  private queue: Promise<unknown> = Promise.resolve();
  private newest: string | undefined;

  constructor(private readonly opts: { agentDir: string; maxBytes?: number; open?: OpenFile }) {}

  /** Serialized, since two pages at once would feed the same file's index twice. */
  page(q: { before?: string; limit: number }): Promise<ChatExportResult> {
    const run = this.queue.then(() => this.pageNow(q));
    this.queue = run.catch(() => {});
    return run;
  }

  private async pageNow(q: { before?: string; limit: number }): Promise<ChatExportResult> {
    const files = this.listFiles();
    this.newest = files.at(-1);
    let fi = files.length - 1;
    let end = Number.POSITIVE_INFINITY;
    if (q.before !== undefined) {
      const at = q.before.lastIndexOf(":");
      const base = at > 0 ? q.before.slice(0, at) : "";
      fi = files.indexOf(base);
      if (fi === -1) throw new ExportCursorError();
      end = ((await this.parse(files[fi]!)) ?? []).findIndex((i) => i.id === q.before);
      if (end === -1) throw new ExportCursorError();
    }
    const maxBytes = this.opts.maxBytes ?? EXPORT_MAX_BYTES;
    const out: ChatExportItem[] = [];
    let bytes = 0;
    for (; fi >= 0; fi--, end = Number.POSITIVE_INFINITY) {
      const items = (await this.parse(files[fi]!)) ?? [];
      for (let i = Math.min(end, items.length) - 1; i >= 0; i--) {
        const item = items[i]!;
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (out.length >= q.limit || (out.length > 0 && bytes + size > maxBytes)) {
          const oldest = out.at(-1)!.id;
          return { items: out.reverse(), before: oldest };
        }
        out.push(item);
        bytes += size;
      }
    }
    return { items: out.reverse(), before: null };
  }

  /** Session file bases in `chat/`, oldest first. Cursors resolve only against this listing. */
  private listFiles(): string[] {
    const dir = this.chatRoot();
    if (!dir) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".jsonl") && !n.startsWith("."))
      .map((n) => n.slice(0, -".jsonl".length))
      .sort();
  }

  private chatRoot(): string | null {
    return realRoots([this.opts.agentDir]).find((r) => basename(r) === SESSION_DIRS.chat) ?? null;
  }

  /** A file's items; an unreadable file has none. */
  private async parse(base: string): Promise<ChatExportItem[] | null> {
    const root = this.chatRoot();
    if (!root) return null;
    const file = confineSessionFile(join(root, `${base}.jsonl`), [root]);
    if (!file) return null;
    let fh: FileHandle | undefined;
    try {
      // Read through the fd confinement vetted, never by re-opening the path.
      fh = await (this.opts.open ?? open)(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await fh.stat();
      if (!st.isFile() || st.nlink > 1) throw new Error("not a regular, singly linked file");
      let state = this.cache.get(base);
      if (state && (state.dev !== st.dev || state.ino !== st.ino || st.size < state.offset || !(await tailMatches(fh, state)))) state = undefined;
      if (state?.result && state.size === st.size && state.mtimeMs === st.mtimeMs) {
        this.touch(base, state);
        return state.result;
      }
      state ??= { dev: st.dev, ino: st.ino, offset: 0, tail: Buffer.alloc(0), index: new SessionIndex(), size: 0, mtimeMs: 0, result: null };
      // Dropped first, so a read that fails halfway can't leave a half-fed index behind.
      this.cache.delete(base);
      await readNewLines(fh, state, st.size);
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
      state.result = convertEntries(state.index.branch(), base);
      this.touch(base, state);
      return state.result;
    } catch (err) {
      this.cache.delete(base);
      log.warn({ err, base }, "reading a chat session file failed; leaving it out of the export");
      return null;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  /** LRU, except the live (newest) file, which changes every turn and is the one worth keeping warm. */
  private touch(base: string, state: FileState): void {
    this.cache.delete(base);
    this.cache.set(base, state);
    if (this.cache.size <= CACHE_FILES) return;
    for (const key of this.cache.keys()) {
      if (key === this.newest) continue;
      this.cache.delete(key);
      return;
    }
  }
}

async function tailMatches(fh: FileHandle, state: FileState): Promise<boolean> {
  if (!state.tail.length) return true;
  const buf = Buffer.alloc(state.tail.length);
  const { bytesRead } = await fh.read(buf, 0, buf.length, state.offset - buf.length);
  return bytesRead === buf.length && buf.equals(state.tail);
}

/** Feeds the complete lines past `state.offset` into the index. A trailing partial line (a write in progress) waits for the next read. */
async function readNewLines(fh: FileHandle, state: FileState, size: number): Promise<void> {
  const buf = Buffer.alloc(READ_CHUNK);
  let pending: Buffer[] = [];
  let pos = state.offset;
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    const chunk = buf.subarray(0, bytesRead);
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
      const line = pending.length ? Buffer.concat([...pending, chunk.subarray(start, nl)]) : chunk.subarray(start, nl);
      state.offset += line.length + 1;
      pending = [];
      if (line.length) state.index.add(line.toString("utf8"));
      start = nl + 1;
    }
    if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
  }
  const n = Math.min(TAIL_BYTES, state.offset);
  state.tail = Buffer.alloc(n);
  if (n) await fh.read(state.tail, 0, n, state.offset - n);
}

export function convertSession(raw: string, base: string): ChatExportItem[] {
  const index = new SessionIndex();
  try {
    for (const line of raw.split("\n")) if (line) index.add(line);
  } catch {
    return [];
  }
  return convertEntries(index.branch(), base);
}

/** Owner messages and the text each turn ended with, as the host delivered it. Flush turns, context, tool
 *  calls, asks and compactions stay out. */
function convertEntries(entries: SlimEntry[], base: string): ChatExportItem[] {
  const items: ChatExportItem[] = [];
  // The current turn's reply: each assistant message replaces its text, so it ends as the last one's.
  let open: ChatExportItem | null = null;
  let hidden = false;
  const at = (e: SlimEntry) => (str(e.timestamp) ? clip(e.timestamp, ID_MAX) : "");
  const itemId = (e: SlimEntry) => `${base}:${e.id}`;

  for (const e of entries) {
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "user") {
        open = null;
        hidden = isFlushPrompt(m.text);
        if (!hidden) {
          const user = userItem(m.text, itemId(e), at(e));
          if (user) items.push(user);
        }
      } else if (m.role === "assistant" && !hidden) {
        if (!open) {
          open = { id: itemId(e), role: "assistant", at: at(e), text: "" };
          items.push(open);
        }
        open.at = at(e);
        // The host delivers the last assistant message's text, and nothing after an error or an abort.
        open.text = m.stopReason === "error" || m.stopReason === "aborted" ? "" : m.text;
      }
    } else if (e.type === "custom" && e.customType === DELIVERY_ENTRY) {
      const marker = deliveryMarker(e.data);
      if (!marker || (marker.kind !== "reply" && marker.kind !== "proactive")) continue;
      if (marker.text !== undefined) {
        // Delivered text of its own (proactive, a failure notice) stands alone; the turn's later output sorts after it.
        open = null;
        items.push({ id: itemId(e), role: "assistant", at: at(e), text: marker.text, outboxId: marker.outboxId });
      } else if (open && !open.outboxId) {
        open.outboxId = marker.outboxId;
      }
    }
  }

  return items.flatMap((item) => {
    if (item.role === "assistant" && isNoReply(item.text)) return [];
    const text = clip(item.text.trim() ? item.text : "", ITEM_TEXT_MAX);
    return text ? [{ ...item, text }] : [];
  });
}

function isFlushPrompt(text: string): boolean {
  return text.startsWith(FLUSH_MARKER);
}

/** An owner turn: a user message with the host's `[surface:id time UTC]` header. Header-less prompts (a subagent's wake) aren't. */
function userItem(raw: string, id: string, entryAt: string): ChatExportItem | null {
  const lines = raw.split("\n");
  const head = HEADER_RE.exec(lines[0] ?? "");
  if (!head && lines[0] !== VOICE_ONLY) return null;
  lines.shift();
  // Pi appends its image notes after a blank line, after the attachment lines.
  while (lines.length && IMAGE_NOTE_RE.test(lines.at(-1)!)) lines.pop();
  while (lines.length && lines.at(-1) === "") lines.pop();
  const attachments: string[] = [];
  for (let a = ATTACHMENT_RE.exec(lines.at(-1) ?? ""); a; a = ATTACHMENT_RE.exec(lines.at(-1) ?? "")) {
    lines.pop();
    attachments.unshift(`[attachment: ${clip(a[1]!, ID_MAX)}]`);
  }
  // The bot has no copy of a pre-web attachment, so a photo-only message keeps just its name.
  const text = lines.join("\n").trim() ? lines.join("\n") : attachments.join("\n");
  const clientId = head?.[1] === "web" ? idOf(head[2]) : undefined;
  return {
    id,
    role: "user",
    at: entryAt || (head ? `${head[3]}T${head[4]}:00.000Z` : ""),
    text,
    ...(clientId ? { clientId } : {}),
  };
}

function deliveryMarker(data: unknown): Pick<DeliveryMarker, "outboxId" | "kind" | "text"> | null {
  const d = data as Record<string, unknown> | null;
  const outboxId = idOf(d?.outboxId);
  const kind = d?.kind;
  if (!d || !outboxId || (kind !== "reply" && kind !== "proactive" && kind !== "ask" && kind !== "auth")) return null;
  return { outboxId, kind, ...(str(d.text) ? { text: d.text } : {}) };
}

export function chatExportHandlers(opts: { principalId: string; reader: ChatExportReader }): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [RPC_METHODS.chatExport]: async (p) => {
      const params = chatExportParams.parse(p);
      if (params.principalId !== opts.principalId) throw new Error(`principal mismatch: this workspace serves ${opts.principalId}, got ${params.principalId}`);
      return await opts.reader.page(params);
    },
  };
}
