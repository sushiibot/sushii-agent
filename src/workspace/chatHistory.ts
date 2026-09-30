import { constants, readdirSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CHAT_HISTORY_UNKNOWN_CURSOR,
  CHAT_HISTORY_UNKNOWN_CURSOR_CODE,
  ID_MAX,
  RPC_METHODS,
  UPLOAD_ID_RE,
  chatHistoryParams,
  chatUsage,
  historyItem,
  parseUploadUrl,
  type ChatDeliverParams,
  type ChatHistoryResult,
  type ChatUsage,
  type HistoryItem,
} from "../orchestration/contracts.ts";
import { summarizeToolArgs } from "../agentRuntime/piShared.ts";
import { RpcHandlerError } from "../orchestration/transport/client.ts";
import { getLogger } from "../logger.ts";
import { isNoReply } from "./events.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { SESSION_DIRS } from "./sessionPaths.ts";
import { confineSessionFile, parseEntry, realRoots, textOf } from "./wsRuns.ts";

const log = getLogger("workspace.chatHistory");

/**
 * The Main transcript as pages for the web app, read from the Pi session JSONL under `<agentDir>/chat`.
 *
 * Session chain: chat sessions are made with `SessionManager.create(cwd, dir)`, which sets no
 * `parentSession`, and Pi names each file `<ISO timestamp>_<uuid>.jsonl` when it is created. The host holds
 * one Main session at a time, so name order is creation order. The host appends a `sushii.session` entry
 * to each session it swaps in, which labels the boundary before it "new" or "rotated"; a file without one
 * (written before the marker existed) counts as "rotated" when it holds a seeded recap, else "new".
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

const RECAP_CUSTOM_TYPE = "workspace_recap";
export const HISTORY_MAX_BYTES = 2_000_000;
const ITEM_TEXT_MAX = 100_000;
const TOOL_SUMMARY_MAX = 120;
const CACHE_FILES = 8;
const START_ID = "start";

const HEADER_RE = /^\[([A-Za-z]+):(\S+) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC(?:, voice message, transcribed)?\]$/;
const VOICE_ONLY = "[voice message, transcribed]";
const ATTACHMENT_RE = /^\[attachment: (.*) \(([^()]*)\) (\S+)(?: → \S+)?\]$/;
const IMAGE_NOTE_RE = /^\[Image(?: omitted)?: .*\]$/;

/** Carries the RPC code the bot maps to 409 {reset:true}. */
export class HistoryCursorError extends RpcHandlerError {
  constructor() {
    super(CHAT_HISTORY_UNKNOWN_CURSOR, CHAT_HISTORY_UNKNOWN_CURSOR_CODE);
  }
}

type Converted = { items: HistoryItem[]; startAt: string; reason: SessionMarker["reason"] };

interface RawEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  summary?: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    toolCallId?: string;
    isError?: boolean;
  };
}

/** An entry cut down to what the conversion reads: no image data, no tool arguments, no tool output. */
interface SlimEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  summary?: string;
  message?: {
    role?: string;
    text: string;
    stopReason?: string;
    toolCallId?: string;
    isError?: boolean;
    tools: Array<{ id?: string; name: string; summary: string }>;
  };
}

const str = (v: unknown): v is string => typeof v === "string";
const idOf = (v: unknown): string | undefined => (str(v) && v.length > 0 && v.length <= ID_MAX ? v : undefined);
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function slim(e: RawEntry & { id: string }): SlimEntry {
  const out: SlimEntry = { type: str(e.type) ? e.type : "", id: e.id, parentId: str(e.parentId) ? e.parentId : null };
  if (str(e.timestamp)) out.timestamp = e.timestamp;
  if (str(e.customType)) out.customType = e.customType;
  if (e.type === "custom" && (e.customType === DELIVERY_ENTRY || e.customType === SESSION_ENTRY)) out.data = e.data;
  if (e.type === "compaction" && str(e.summary)) out.summary = e.summary;
  if (e.type === "message" && e.message) {
    const m = e.message;
    const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    out.message = {
      ...(str(m.role) ? { role: m.role } : {}),
      text: m.role === "toolResult" ? "" : textOf(m.content),
      ...(str(m.stopReason) ? { stopReason: m.stopReason } : {}),
      ...(str(m.toolCallId) ? { toolCallId: m.toolCallId } : {}),
      ...(m.isError === true ? { isError: true } : {}),
      tools:
        m.role === "assistant"
          ? content
              .filter((c) => c?.type === "toolCall" && str(c.name))
              .map((c) => ({
                ...(str(c.id) ? { id: c.id } : {}),
                name: clip(c.name as string, ID_MAX),
                summary: summarizeToolArgs(c.arguments).replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_MAX),
              }))
          : [],
    };
  }
  return out;
}

/** A session file's entries as they are appended, indexed so the branch can be re-derived after each append. */
class SessionIndex {
  header: { timestamp?: string } | null = null;
  private readonly byId = new Map<string, SlimEntry>();
  private leaf: string | null = null;
  private lines = 0;

  /** One JSONL line; a line that doesn't parse (a torn write) is skipped. Throws when the file doesn't open with a session header. */
  add(line: string): void {
    const e = parseEntry(line) as RawEntry | null;
    if (this.lines++ === 0 && e?.type !== "session") throw new Error("not a session file");
    if (!e) return;
    if (e.type === "session") {
      this.header ??= str(e.timestamp) ? { timestamp: e.timestamp } : {};
      return;
    }
    if (!str(e.id)) return;
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
  result: Converted | null;
}

const READ_CHUNK = 1024 * 1024;
const TAIL_BYTES = 256;

export type OpenFile = (path: string, flags: number) => Promise<FileHandle>;

export class ChatHistoryReader {
  private readonly cache = new Map<string, FileState>();
  private queue: Promise<unknown> = Promise.resolve();
  private newest: string | undefined;

  constructor(private readonly opts: { agentDir: string; maxBytes?: number; open?: OpenFile }) {}

  /** Serialized, since two pages at once would feed the same file's index twice. */
  page(q: { before?: string; limit: number }): Promise<ChatHistoryResult> {
    const run = this.queue.then(() => this.pageNow(q));
    this.queue = run.catch(() => {});
    return run;
  }

  private async pageNow(q: { before?: string; limit: number }): Promise<ChatHistoryResult> {
    const files = this.listFiles();
    this.newest = files.at(-1);
    let fi = files.length - 1;
    let end = Number.POSITIVE_INFINITY;
    if (q.before !== undefined) {
      const at = q.before.lastIndexOf(":");
      const base = at > 0 ? q.before.slice(0, at) : "";
      fi = files.indexOf(base);
      if (fi === -1) throw new HistoryCursorError();
      end = (await this.itemsOf(files, fi)).findIndex((i) => i.id === q.before);
      if (end === -1) throw new HistoryCursorError();
    }
    const maxBytes = this.opts.maxBytes ?? HISTORY_MAX_BYTES;
    const out: HistoryItem[] = [];
    let bytes = 0;
    for (; fi >= 0; fi--, end = Number.POSITIVE_INFINITY) {
      const items = await this.itemsOf(files, fi);
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

  /** A file's items, led by the boundary divider when an older session precedes it. An unreadable file has none. */
  private async itemsOf(files: string[], fi: number): Promise<HistoryItem[]> {
    const base = files[fi]!;
    const parsed = await this.parse(base);
    if (!parsed) return [];
    if (fi === 0) return parsed.items;
    const divider: HistoryItem = { type: "divider", id: `${base}:${START_ID}`, at: parsed.startAt, kind: parsed.reason };
    return [divider, ...parsed.items];
  }

  private async parse(base: string): Promise<Converted | null> {
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
      state.result = convertEntries(state.index.header, state.index.branch(), base);
      this.touch(base, state);
      return state.result;
    } catch (err) {
      this.cache.delete(base);
      log.warn({ err, base }, "reading a chat session file failed; leaving it out of history");
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

type AssistantItem = Extract<HistoryItem, { type: "assistant" }>;
type Tool = AssistantItem["tools"][number];

export function convertSession(raw: string, base: string): Converted {
  const index = new SessionIndex();
  try {
    for (const line of raw.split("\n")) if (line) index.add(line);
  } catch {
    return { items: [], startAt: "", reason: "new" };
  }
  return convertEntries(index.header, index.branch(), base);
}

function convertEntries(header: { timestamp?: string } | null, entries: SlimEntry[], base: string): Converted {
  const items: HistoryItem[] = [];
  const tools = new Map<string, Tool>();
  // The current turn's calls still waiting for a result. An earlier turn's never-answered call failed; this
  // turn's may still be running (say, waiting for an approval), so it is left out rather than shown failed.
  let awaiting = new Map<Tool, AssistantItem>();
  let open: AssistantItem | null = null;
  // The newest assistant item since the last owner turn: a turn's reply marker lands on it.
  let turnReply: AssistantItem | null = null;
  let hidden = false;
  let recap = false;
  let reason: SessionMarker["reason"] | null = null;
  const at = (e: SlimEntry) => (str(e.timestamp) ? clip(e.timestamp, ID_MAX) : "");
  const itemId = (e: SlimEntry) => `${base}:${e.id}`;

  for (const e of entries) {
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "user") {
        open = null;
        turnReply = null;
        awaiting = new Map();
        hidden = isFlushPrompt(m.text);
        if (!hidden) {
          const user = userItem(m.text, itemId(e), at(e));
          if (user) items.push(user);
        }
      } else if (m.role === "assistant" && !hidden) {
        if (!open) {
          open = { type: "assistant", id: itemId(e), at: at(e), text: "", tools: [] };
          items.push(open);
          turnReply = open;
        }
        open.at = at(e);
        // The host delivers the last assistant message's text, and nothing after an error or an abort.
        open.text = m.stopReason === "error" || m.stopReason === "aborted" ? "" : m.text;
        for (const c of m.tools) {
          const tool: Tool = { name: c.name, summary: c.summary, ok: false };
          open.tools.push(tool);
          awaiting.set(tool, open);
          if (c.id) tools.set(c.id, tool);
        }
      } else if (m.role === "toolResult" && !hidden && str(m.toolCallId)) {
        const tool = tools.get(m.toolCallId);
        if (tool) {
          tool.ok = m.isError !== true;
          awaiting.delete(tool);
        }
      }
    } else if (e.type === "custom" && e.customType === DELIVERY_ENTRY) {
      const marker = deliveryMarker(e.data);
      if (!marker || marker.kind === "auth") continue;
      // A standalone item mid-run closes the open assistant item, so the turn's later output sorts after it.
      if (marker.kind === "ask") {
        if (marker.ask) items.push({ type: "ask", id: itemId(e), at: at(e), outboxId: marker.outboxId, ...marker.ask });
        open = null;
      } else if (marker.text !== undefined) {
        open = null;
        items.push({
          type: "assistant",
          id: itemId(e),
          at: at(e),
          text: clip(marker.text, ITEM_TEXT_MAX),
          outboxId: marker.outboxId,
          ...(marker.turnId ? { turnId: marker.turnId } : {}),
          tools: [],
          ...(marker.usage ? { usage: marker.usage } : {}),
        });
      } else if (turnReply && !turnReply.outboxId) {
        turnReply.outboxId = marker.outboxId;
        if (marker.turnId) turnReply.turnId = marker.turnId;
        if (marker.usage) turnReply.usage = marker.usage;
      }
    } else if (e.type === "custom" && e.customType === SESSION_ENTRY) {
      const r = (e.data as { reason?: unknown } | undefined)?.reason;
      if (r === "new" || r === "rotated") reason ??= r;
    } else if (e.type === "custom_message" && e.customType === RECAP_CUSTOM_TYPE) {
      recap = true;
    } else if (e.type === "compaction") {
      open = null;
      items.push({ type: "divider", id: itemId(e), at: at(e), kind: "compacted", ...(str(e.summary) ? { summary: clip(e.summary, ITEM_TEXT_MAX) } : {}) });
    }
  }

  for (const [tool, item] of awaiting) item.tools = item.tools.filter((t) => t !== tool);

  const kept: HistoryItem[] = [];
  for (const item of items) {
    if (item.type === "assistant") {
      if (isNoReply(item.text)) item.text = "";
      item.text = clip(item.text, ITEM_TEXT_MAX);
      if (!item.text && !item.tools.length && !item.outboxId) continue;
    }
    const ok = historyItem.safeParse(item);
    if (ok.success) kept.push(ok.data);
    else log.warn({ id: item.id, type: item.type, issues: ok.error.issues.length }, "dropping a history item that fails the wire schema");
  }
  const startAt = (header && str(header.timestamp) ? header.timestamp : entries[0]?.timestamp) ?? "";
  return { items: kept, startAt: clip(startAt, ID_MAX), reason: reason ?? (recap ? "rotated" : "new") };
}

function isFlushPrompt(text: string): boolean {
  return text.startsWith(FLUSH_MARKER);
}

/** An owner turn: a user message with the host's `[surface:id time UTC]` header. Header-less prompts (a subagent's wake) aren't. */
function userItem(raw: string, id: string, fallbackAt: string): HistoryItem | null {
  const lines = raw.split("\n");
  const head = HEADER_RE.exec(lines[0] ?? "");
  if (!head && lines[0] !== VOICE_ONLY) return null;
  lines.shift();
  // Pi appends its image notes after a blank line, after the attachment lines.
  while (lines.length && IMAGE_NOTE_RE.test(lines.at(-1)!)) lines.pop();
  while (lines.length && lines.at(-1) === "") lines.pop();
  const attachments: Extract<HistoryItem, { type: "user" }>["attachments"] = [];
  for (;;) {
    const a = ATTACHMENT_RE.exec(lines.at(-1) ?? "");
    if (!a) break;
    lines.pop();
    const uploadId = parseUploadUrl(a[3]!);
    attachments.unshift({ ...(uploadId && UPLOAD_ID_RE.test(uploadId) ? { uploadId } : {}), name: clip(a[1]!, ID_MAX), contentType: clip(a[2]!, ID_MAX) });
  }
  const surface = head?.[1];
  const clientId = surface === "web" ? idOf(head?.[2]) : undefined;
  return {
    type: "user",
    id,
    ...(clientId ? { clientId } : {}),
    at: head ? `${head[3]}T${head[4]}:00.000Z` : fallbackAt,
    text: clip(lines.join("\n"), ITEM_TEXT_MAX),
    attachments,
  };
}

function deliveryMarker(data: unknown): DeliveryMarker | null {
  const d = data as Record<string, unknown> | null;
  const outboxId = idOf(d?.outboxId);
  const kind = d?.kind;
  if (!d || !outboxId || (kind !== "reply" && kind !== "proactive" && kind !== "ask" && kind !== "auth")) return null;
  const usage = chatUsage.safeParse(d.usage);
  const a = d.ask as Record<string, unknown> | undefined;
  const askId = idOf(a?.askId);
  return {
    outboxId,
    kind,
    ...(idOf(d.turnId) ? { turnId: d.turnId as string } : {}),
    ...(str(d.text) ? { text: d.text } : {}),
    ...(usage.success ? { usage: usage.data } : {}),
    ...(askId && str(a?.question)
      ? { ask: { askId, question: clip(a.question, ITEM_TEXT_MAX), choices: Array.isArray(a.choices) ? a.choices.filter(str).map((c) => clip(c, ID_MAX)) : [] } }
      : {}),
  };
}

export function chatHistoryHandlers(opts: { principalId: string; reader: ChatHistoryReader }): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [RPC_METHODS.chatHistory]: async (p) => {
      const params = chatHistoryParams.parse(p);
      if (params.principalId !== opts.principalId) throw new Error(`principal mismatch: this workspace serves ${opts.principalId}, got ${params.principalId}`);
      return await opts.reader.page(params);
    },
  };
}
