import type { Database } from "bun:sqlite";
import { CHAT_EXPORT_LIMIT_MAX, chatExportResult, type ChatExportResult } from "../../orchestration/contracts.ts";
import { getLogger } from "../../logger.ts";
import type { SqliteChatLog } from "./chatLog.ts";
import { MESSAGE_TEXT_MAX } from "./events.ts";
import { capText, REPLY_TEXT_MAX } from "./workspaceAdapter.ts";

const log = getLogger("web/chatImport");

export const IMPORT_DONE_KEY = "web_events:pi_import_done";
/** Fixed on the first attempt, so a resumed import cuts at the same point even after a prune. */
export const IMPORT_CUTOFF_KEY = "web_events:pi_import_cutoff";
export const IMPORT_MAX_MESSAGES = 5_000;
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Keeps imported keys apart from clientIds (ULIDs) and workspace outbox ids. */
export const IMPORT_KEY_PREFIX = "pi:";

export interface ExportSource {
  chatExport(q: { before?: string; limit: number }): Promise<ChatExportResult>;
}

export interface ImportOutcome {
  imported: number;
  /** Items past the message or byte cap, oldest part of the transcript. */
  skipped: number;
}

/**
 * Copies the Main conversation from before the web app out of the workspace's Pi sessions into the bot's
 * chat log, once. It walks the export newest first and stores each owner message and reply below every
 * live row, keyed by its Pi entry id, so a rerun after a crash resumes without duplicates. Only items older
 * than the first live row are taken; the bot already holds anything newer.
 */
export async function importPiChat(deps: {
  db: Database;
  log: SqliteChatLog;
  source: ExportSource;
  now?: () => number;
  maxMessages?: number;
  maxBytes?: number;
}): Promise<ImportOutcome | null> {
  const { db, log: chatLog, source } = deps;
  if (kvGet(db, IMPORT_DONE_KEY) !== null) return null;
  const maxMessages = deps.maxMessages ?? IMPORT_MAX_MESSAGES;
  const maxBytes = deps.maxBytes ?? IMPORT_MAX_BYTES;
  let cutoff = Number(kvGet(db, IMPORT_CUTOFF_KEY));
  if (!kvGet(db, IMPORT_CUTOFF_KEY) || !Number.isFinite(cutoff)) {
    cutoff = chatLog.firstLiveAt() ?? (deps.now ?? Date.now)();
    kvSet(db, IMPORT_CUTOFF_KEY, String(cutoff));
  }

  let taken = 0;
  let bytes = 0;
  let imported = 0;
  let skipped = 0;
  let before: string | undefined;
  for (;;) {
    const page = chatExportResult.parse(await source.chatExport({ ...(before !== undefined ? { before } : {}), limit: CHAT_EXPORT_LIMIT_MAX }));
    const rows: Parameters<SqliteChatLog["prepend"]>[0][number][] = [];
    for (const item of [...page.items].reverse()) {
      const at = Date.parse(item.at);
      if (!Number.isFinite(at) || at >= cutoff) continue;
      // Delivered to the web app before this cutoff was taken, so the bot already has it under its own key.
      if (item.clientId && chatLog.find("user", item.clientId)) continue;
      if (item.outboxId && (chatLog.find("reply", item.outboxId) || chatLog.find("proactive", item.outboxId))) continue;
      const key = `${IMPORT_KEY_PREFIX}${item.id}`;
      const iso = new Date(at).toISOString();
      const row =
        item.role === "user"
          ? { type: "user" as const, key, data: { key, text: capText(item.text, MESSAGE_TEXT_MAX), uploadIds: [], at: iso }, createdAt: at }
          : { type: "reply" as const, key, data: { key, text: capText(item.text, REPLY_TEXT_MAX), files: [] }, createdAt: at };
      const size = Buffer.byteLength(row.data.text);
      if (taken >= maxMessages || bytes + size > maxBytes) {
        skipped++;
        continue;
      }
      taken++;
      bytes += size;
      rows.push(row);
    }
    imported += chatLog.prepend(rows);
    if (page.before === null) break;
    before = page.before;
  }
  kvSet(db, IMPORT_DONE_KEY, JSON.stringify({ imported, skipped, at: (deps.now ?? Date.now)() }));
  if (skipped) log.warn({ imported, skipped, maxMessages, maxBytes }, "chat import hit its cap; the oldest messages were left out");
  else log.info({ imported }, "imported the pre-web chat");
  return { imported, skipped };
}

/** Runs the import on each workspace connect until it has finished once; never two at a time. */
export function createPiChatImporter(deps: Parameters<typeof importPiChat>[0]): { run(): Promise<void> } {
  let running: Promise<void> | null = null;
  return {
    run() {
      running ??= importPiChat(deps)
        .then(() => {}, (err) => log.warn({ err }, "chat import failed; retrying on the next workspace connect"))
        .finally(() => (running = null));
      return running;
    },
  };
}

function kvGet(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}

function kvSet(db: Database, key: string, value: string): void {
  db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
