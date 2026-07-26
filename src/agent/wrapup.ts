import type { ModelMessage } from "ai";

/** Why the agent loop stopped short of a natural finish. */
export type StopReason = "iterations" | "context";

export const WRAP_UP_PROMPT =
  "[System: You have reached the maximum number of steps. You cannot investigate further — call submit_final_answer with your complete write-up: summarize what you found so far and state plainly what you did not get to. Any msg: citation must come from tool output already in this conversation — never invent one.]";

export const WRAP_UP_RETRY_PROMPT =
  "[System: Your last attempt didn't come through. Call submit_final_answer now with the complete write-up in the text field — that's the only way to respond. Only cite msg: references that already appear in this conversation's tool output.]";

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

export const SUBMIT_FINAL_ANSWER_TOOL_NAME = "submit_final_answer";

export interface WrapUpToolCall {
  toolName: string;
  input: unknown;
}

const TRUNCATED_TEXT_FIELD = /^\s*\{\s*"text"\s*:\s*"/;

/**
 * Salvages readable prose from a `{"text": "..."` argument that was cut off mid-string.
 * Truncation is the expected failure for a long formatted answer, so returning the raw
 * fragment would show the moderator JSON scaffolding and literal \n escapes.
 */
function recoverTruncatedAnswer(raw: string): string {
  const opening = TRUNCATED_TEXT_FIELD.exec(raw);
  if (!opening) return raw;

  const body = raw
    .slice(opening[0].length)
    .replace(/\\+$/, "")
    .replace(/"\s*\}?\s*$/, "");

  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

/**
 * Extracts the answer from a forced wrap-up call. The model reliably calls a tool here (it's
 * copying 30 prior tool-call turns) but the shape of `input` is unreliable — the AI SDK falls
 * back to the raw JSON string, or even the un-parseable raw string, whenever the ~600-token
 * formatted answer doesn't survive JSON encoding intact. A truncated answer beats no answer.
 */
export function extractSubmittedAnswer(
  toolCalls: WrapUpToolCall[] | undefined,
  toolName: string = SUBMIT_FINAL_ANSWER_TOOL_NAME,
): string {
  if (!toolCalls?.length) return "";

  for (const call of toolCalls) {
    if (call.toolName !== toolName) continue;

    const { input } = call;
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
          const text = (parsed as { text: string }).text.trim();
          if (text) return text;
        } else {
          continue;
        }
      } catch {
        const raw = recoverTruncatedAnswer(input).trim();
        if (raw) return raw;
      }
      continue;
    }

    if (input && typeof input === "object" && typeof (input as { text?: unknown }).text === "string") {
      const text = (input as { text: string }).text.trim();
      if (text) return text;
    }
  }

  return "";
}

const REASONING_SALVAGE_PREFIX =
  "I couldn't put together a proper write-up before running out of steps. What follows are raw, unreviewed investigation notes — they may contain dead ends, wrong guesses, or hypotheses I ended up ruling out. Treat this as a starting point, not a finding:\n\n";

/**
 * Wraps raw model reasoning as a last-resort answer. Deliberately never appends a
 * "Recommended action" line — the reasoning may name real users inside hypotheses the model
 * later retracted, and a bolded recommendation reads as a conclusion even when it isn't one.
 */
export function buildReasoningSalvage(reasoningText: string, maxLength = 3500): string {
  const trimmed = reasoningText.trim();
  if (!trimmed) return "";

  const budget = maxLength - REASONING_SALVAGE_PREFIX.length;
  const body = trimmed.length > budget ? `${trimmed.slice(0, Math.max(0, budget - 1))}…` : trimmed;
  return `${REASONING_SALVAGE_PREFIX}${body}`;
}
