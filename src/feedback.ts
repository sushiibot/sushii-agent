import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "./config.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("feedback");

export interface FeedbackEntry {
  threadId: string;
  guildId: string;
  userId: string;
  username: string;
  sentiment: "positive" | "negative";
  feedback: string;
  timestamp: string;
  conversation: unknown[];
}

export function saveFeedback(entry: FeedbackEntry): string {
  mkdirSync(config.feedbackPath, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `feedback-${entry.threadId}-${ts}.json`;
  const filepath = join(config.feedbackPath, filename);
  writeFileSync(filepath, JSON.stringify(entry, null, 2), "utf8");
  logger.info({ filepath, sentiment: entry.sentiment, threadId: entry.threadId }, "Feedback saved");
  return filepath;
}
