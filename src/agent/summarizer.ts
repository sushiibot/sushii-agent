import { generateText, type ModelMessage } from "ai";
import { openaiProvider } from "./client.ts";
import { config } from "../config.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("agent/summarizer");

const SUMMARIZE_SYSTEM =
  "You are compacting a long assistant conversation so it fits the context window. Write a concise but " +
  "faithful summary of the messages below: preserve decisions made, facts established, the user's stated " +
  "preferences, unresolved threads, and any context needed to continue the conversation naturally. Do not " +
  "invent anything and do not add commentary — output only the summary.";

/** Model-backed summarize function for the compaction fold. Uses COMPACTION_MODEL when set (pick a
 *  cheap model — this runs over long histories), else the main model. Returns a sentinel on failure so
 *  a folded turn is never silently dropped. */
export function createModelSummarizer(): (messages: ModelMessage[]) => Promise<string> {
  const model = openaiProvider(config.compactionModel || config.openaiModel);
  return async (messages) => {
    try {
      const res = await generateText({
        model,
        messages: [{ role: "system", content: SUMMARIZE_SYSTEM }, ...messages],
        maxOutputTokens: 1024,
      });
      const text = res.text?.trim();
      if (text) return text;
      logger.warn("compaction summarizer returned empty text");
    } catch (err) {
      logger.error({ err }, "compaction summarizer failed");
    }
    return "[Earlier conversation omitted — summary unavailable.]";
  };
}
