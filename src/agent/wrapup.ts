import type { ModelMessage } from "ai";

/** Why the agent loop stopped short of a natural finish. */
export type StopReason = "iterations" | "context";

export const WRAP_UP_PROMPT =
  "[System: You have reached the maximum number of steps. Do NOT call any more tools — any tool call now is discarded and the user sees nothing. Reply with plain text only: summarize what you found so far and state plainly what you did not get to.]";

export const WRAP_UP_RETRY_PROMPT =
  "[System: Your last reply contained no text. Tools are unavailable. Answer now in plain prose with what you have.]";

export const WRAP_UP_EMPTY_HISTORY = "(no text produced)";

export function buildLimitNote(stopReason: StopReason): string {
  const cause = stopReason === "context" ? "ran out of room in this conversation" : "hit the tool step limit";
  return `-# ⚠️ Stopped early — ${cause}, so this is based only on what I gathered so far. Reply to keep going.`;
}

export function buildBudgetWarning(remaining: number): string {
  return `[System: You have ${remaining} tool-calling step${remaining === 1 ? "" : "s"} left before you must give a final answer. Prioritize the checks that matter most. If you can't finish everything, give the user what you have so far and say what's still unanswered.]`;
}

/** Model text fit to show a user — internal preambles read as gibberish in Discord. */
export function usableText(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("[Internal:") ? "" : trimmed;
}

/**
 * Persist the model's turn, substituting plain text whenever it carries tool calls we won't be
 * answering. An assistant tool call with no matching tool result makes every later request in the
 * thread invalid, and it survives in the DB until someone edits it out by hand.
 */
export function pushAssistantTurn(
  messages: ModelMessage[],
  result: { text: string; toolCalls?: unknown[]; response: { messages: ModelMessage[] } },
): void {
  if (result.toolCalls?.length) {
    messages.push({ role: "assistant", content: result.text.trim() || "(no response)" });
  } else {
    messages.push(...result.response.messages);
  }
}

/** Last-resort user-facing text when the model never produces prose on the forced wrap-up. */
export function buildToolSummaryFallback(usedTools: { name: string }[], stopReason: StopReason): string {
  const cause = stopReason === "context" ? "ran out of room" : "hit the step limit";
  const names = [...new Set(usedTools.map((t) => t.name))];
  const ran = names.length ? ` I ran: ${names.join(", ")}.` : "";
  return `I ${cause} before I could write up what I found.${ran}`;
}
