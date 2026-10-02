import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatEventPayload, ChatUsage } from "../orchestration/contracts.ts";
import { summarizeToolArgs } from "../agentRuntime/piShared.ts";
import { CHATGPT_PROVIDER, modelLabel, publicAuthError } from "./chatgptFallback.ts";

import { isNoReply } from "../orchestration/contracts.ts";

export { NO_REPLY, isNoReply } from "../orchestration/contracts.ts";

const TOOL_SUMMARY_MAX = 120;

/** What one agent run (prompt → settled, including steers) has produced so far. */
export interface RunAccumulator {
  finalText: string;
  outputStarted?: boolean;
  modelActivity?: "waiting" | "thinking";
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  lastStopReason: string | undefined;
  errorMessage: string | undefined;
  /** The model that produced the latest assistant message. */
  model: string | undefined;
}

export function newRunAccumulator(): RunAccumulator {
  return { finalText: "", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, lastStopReason: undefined, errorMessage: undefined, model: undefined };
}

interface AssistantLike {
  role: "assistant";
  provider?: string;
  model?: string;
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

function asAssistant(message: unknown): AssistantLike | null {
  const m = message as { role?: unknown; content?: unknown } | null;
  return m && m.role === "assistant" && Array.isArray(m.content) ? (m as AssistantLike) : null;
}

export function assistantText(message: AssistantLike): string {
  return message.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/**
 * Folds one Pi session event into the run accumulator and returns the live chat events it maps to.
 * text_delta is returned raw; the caller throttles it.
 */
export function mapSessionEvent(event: AgentSessionEvent, acc: RunAccumulator): ChatEventPayload[] {
  switch (event.type) {
    case "tool_execution_start": {
      acc.outputStarted = true;
      const summary = summarizeToolArgs(event.args).replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_MAX);
      return [{ type: "tool_start", name: event.toolName, summary, toolCallId: event.toolCallId }];
    }
    case "tool_execution_end":
      return [{ type: "tool_end", name: event.toolName, ok: event.isError !== true, toolCallId: event.toolCallId }];
    case "message_update": {
      const m = event.assistantMessageEvent;
      if (m.type === "text_delta" && m.delta) acc.outputStarted = true;
      if (!acc.outputStarted) {
        const activity = m.type === "thinking_delta" && m.delta ? "thinking" : m.type === "thinking_end" ? "waiting" : undefined;
        if (activity && activity !== acc.modelActivity) {
          acc.modelActivity = activity;
          return [{ type: "model_activity", activity }];
        }
      }
      return m.type === "text_delta" && m.delta ? [{ type: "text_delta", text: m.delta }] : [];
    }
    case "message_end": {
      const msg = asAssistant(event.message);
      if (!msg) return [];
      const u = msg.usage;
      acc.inputTokens += u?.input ?? 0;
      acc.outputTokens += u?.output ?? 0;
      acc.cacheRead += u?.cacheRead ?? 0;
      acc.cacheWrite += u?.cacheWrite ?? 0;
      // A ChatGPT sign-in turn is paid by the subscription; Pi's catalog price would be misleading.
      if (msg.provider !== CHATGPT_PROVIDER) acc.costUsd += u?.cost?.total ?? 0;
      if (msg.provider && msg.model) acc.model = modelLabel(msg.provider, msg.model);
      acc.lastStopReason = msg.stopReason;
      // Shown in chat and recorded in the run log, so a failed token refresh must not carry the endpoint's body.
      acc.errorMessage = msg.stopReason === "error" ? publicAuthError(msg.errorMessage ?? "unknown error") : undefined;
      acc.finalText = assistantText(msg);
      // An interrupted reasoning stream must not claim to think during retry/provider latency.
      if (!acc.outputStarted && acc.modelActivity === "thinking") {
        acc.modelActivity = "waiting";
        return [{ type: "model_activity", activity: "waiting" }];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Aborted when the last message says so, or when an abort landed before the run produced a complete reply. */
export function runAborted(acc: RunAccumulator, abortRequested: boolean): boolean {
  if (acc.lastStopReason === "aborted") return true;
  return abortRequested && acc.lastStopReason !== "stop" && acc.lastStopReason !== "length";
}

/** The reply to deliver for a settled, non-aborted run, or null when there is nothing to say. */
export function replyText(acc: RunAccumulator): string | null {
  if (acc.lastStopReason === "error") return null;
  const text = acc.finalText.trim();
  if (!text || isNoReply(text)) return null;
  return acc.finalText;
}

/** `defaultModel` names the model when the run produced no assistant message. */
export function runUsage(acc: RunAccumulator, defaultModel: string, contextPercent: number | null | undefined): ChatUsage {
  return {
    model: acc.model ?? defaultModel,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    ...(acc.cacheRead ? { cacheRead: acc.cacheRead } : {}),
    ...(acc.cacheWrite ? { cacheWrite: acc.cacheWrite } : {}),
    // OpenRouter is registered with zero per-token prices and ChatGPT turns are excluded, so a zero means "unknown", not free.
    ...(acc.costUsd > 0 ? { costUsd: acc.costUsd } : {}),
    ...(contextPercent != null ? { contextPct: contextPercent } : {}),
  };
}

export function failureNotice(reason: string): string {
  const line = reason.split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";
  return `⚠️ Turn failed: ${line.length > 200 ? `${line.slice(0, 199)}…` : line}`;
}
