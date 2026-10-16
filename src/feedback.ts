import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "./config.ts";
import { getLogger } from "./logger.ts";
import { CLEANUP_RETENTION_MS } from "./db/retention.ts";

const logger = getLogger("feedback");

export interface FeedbackEntry {
  threadId: string;
  guildId: string;
  userId: string;
  username: string;
  sentiment: "positive" | "negative";
  feedback: string;
  timestamp: string;
}

/** Feedback does not need a second copy of the conversation. Remove legacy snapshots too. */
export function purgeFeedback(directory = config.feedbackPath, now = Date.now()): void {
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (!file.isFile() || !/^feedback-.*\.json$/.test(file.name)) continue;
    const path = join(directory, file.name);
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(path, "utf8"));
      if (!entry || typeof entry !== "object") throw new Error("Invalid feedback");
    } catch {
      unlinkSync(path); // Unreadable legacy feedback has no verifiable retention deadline.
      continue;
    }
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || timestamp <= now - CLEANUP_RETENTION_MS || timestamp > now) {
      unlinkSync(path);
    } else if ("conversation" in entry) {
      delete entry.conversation;
      writeFileSync(path, JSON.stringify(entry, null, 2), { mode: 0o600 });
    }
  }
}

export function saveFeedback(entry: FeedbackEntry): string {
  purgeFeedback();
  mkdirSync(config.feedbackPath, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `feedback-${entry.threadId}-${ts}.json`;
  const filepath = join(config.feedbackPath, filename);
  writeFileSync(filepath, JSON.stringify(entry, null, 2), { mode: 0o600 });
  logger.info({ filepath, sentiment: entry.sentiment, threadId: entry.threadId }, "Feedback saved");
  return filepath;
}
