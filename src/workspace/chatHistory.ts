import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
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

export class HistoryCursorError extends Error {
  constructor() {
    super("unknown history cursor");
  }
}

interface ParsedFile {
  size: number;
  mtimeMs: number;
  items: HistoryItem[];
  startAt: string;
  reason: SessionMarker["reason"];
}

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

const str = (v: unknown): v is string => typeof v === "string";
const idOf = (v: unknown): string | undefined => (str(v) && v.length > 0 && v.length <= ID_MAX ? v : undefined);
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export class ChatHistoryReader {
  private readonly cache = new Map<string, ParsedFile>();

  constructor(private readonly opts: { agentDir: string; maxBytes?: number }) {}

  page(q: { before?: string; limit: number }): ChatHistoryResult {
    const files = this.listFiles();
    let fi = files.length - 1;
    let end = Number.POSITIVE_INFINITY;
    if (q.before !== undefined) {
      const at = q.before.lastIndexOf(":");
      const base = at > 0 ? q.before.slice(0, at) : "";
      fi = files.indexOf(base);
      if (fi === -1) throw new HistoryCursorError();
      end = this.itemsOf(files, fi).findIndex((i) => i.id === q.before);
      if (end === -1) throw new HistoryCursorError();
    }
    const maxBytes = this.opts.maxBytes ?? HISTORY_MAX_BYTES;
    const out: HistoryItem[] = [];
    let bytes = 0;
    for (; fi >= 0; fi--, end = Number.POSITIVE_INFINITY) {
      const items = this.itemsOf(files, fi);
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

  /** A file's items, led by the boundary divider when an older session precedes it. */
  private itemsOf(files: string[], fi: number): HistoryItem[] {
    const base = files[fi]!;
    const parsed = this.parse(base);
    if (!parsed) return [];
    if (fi === 0) return parsed.items;
    const divider: HistoryItem = { type: "divider", id: `${base}:${START_ID}`, at: parsed.startAt, kind: parsed.reason };
    return [divider, ...parsed.items];
  }

  private parse(base: string): ParsedFile | null {
    const root = this.chatRoot();
    if (!root) return null;
    const file = confineSessionFile(join(root, `${base}.jsonl`), [root]);
    if (!file) return null;
    let st;
    try {
      st = statSync(file);
    } catch {
      return null;
    }
    const cached = this.cache.get(base);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      this.cache.delete(base);
      this.cache.set(base, cached);
      return cached;
    }
    const parsed: ParsedFile = { size: st.size, mtimeMs: st.mtimeMs, ...convertSession(readFileSync(file, "utf8"), base) };
    this.cache.set(base, parsed);
    if (this.cache.size > CACHE_FILES) this.cache.delete(this.cache.keys().next().value!);
    return parsed;
  }
}

/** The entries on the path from the file's last entry back to its root, root first (Pi's own leaf rule). */
function branchOf(raw: string): { header: RawEntry | null; entries: RawEntry[] } {
  let header: RawEntry | null = null;
  const byId = new Map<string, RawEntry>();
  let leaf: RawEntry | null = null;
  // A torn last line (a write in progress) fails to parse and is skipped.
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const e = parseEntry(line) as RawEntry | null;
    if (!e) continue;
    if (e.type === "session") {
      header ??= e;
      continue;
    }
    if (!str(e.id)) continue;
    byId.set(e.id, e);
    leaf = e;
  }
  const path: RawEntry[] = [];
  const seen = new Set<string>();
  for (let e = leaf; e && str(e.id) && !seen.has(e.id); e = str(e.parentId) ? (byId.get(e.parentId) ?? null) : null) {
    seen.add(e.id);
    path.push(e);
  }
  return { header, entries: path.reverse() };
}

type AssistantItem = Extract<HistoryItem, { type: "assistant" }>;
type Tool = AssistantItem["tools"][number];

export function convertSession(raw: string, base: string): Pick<ParsedFile, "items" | "startAt" | "reason"> {
  const { header, entries } = branchOf(raw);
  const items: HistoryItem[] = [];
  const tools = new Map<string, Tool>();
  let open: AssistantItem | null = null;
  // The newest assistant item since the last owner turn: a turn's reply marker lands on it.
  let turnReply: AssistantItem | null = null;
  let hidden = false;
  let recap = false;
  let reason: SessionMarker["reason"] | null = null;
  const at = (e: RawEntry) => (str(e.timestamp) ? clip(e.timestamp, ID_MAX) : "");
  const itemId = (e: RawEntry) => `${base}:${e.id}`;

  for (const e of entries) {
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (m.role === "user") {
        open = null;
        turnReply = null;
        const text = textOf(m.content);
        hidden = isFlushPrompt(text);
        if (!hidden) {
          const user = userItem(text, itemId(e), at(e));
          if (user) items.push(user);
        }
      } else if (m.role === "assistant" && !hidden) {
        if (!open) {
          open = { type: "assistant", id: itemId(e), at: at(e), text: "", tools: [] };
          items.push(open);
          turnReply = open;
        }
        open.at = at(e);
        const text = textOf(m.content);
        if (text.trim() && m.stopReason !== "error" && m.stopReason !== "aborted") open.text = text;
        for (const c of Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []) {
          if (c?.type !== "toolCall" || !str(c.name)) continue;
          const tool: Tool = { name: clip(c.name, ID_MAX), summary: summarizeToolArgs(c.arguments).replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_MAX), ok: false };
          open.tools.push(tool);
          if (str(c.id)) tools.set(c.id, tool);
        }
      } else if (m.role === "toolResult" && !hidden && str(m.toolCallId)) {
        const tool = tools.get(m.toolCallId);
        if (tool) tool.ok = m.isError !== true;
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
      return opts.reader.page(params);
    },
  };
}
