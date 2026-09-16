import type { ModelMessage } from "ai";
import { generateText, jsonSchema } from "ai";
import {
  WRAP_UP_PROMPT,
  WRAP_UP_RETRY_PROMPT,
  WRAP_UP_EMPTY_HISTORY,
  SUBMIT_FINAL_ANSWER_TOOL_NAME,
  buildLimitNote,
  buildBudgetWarning,
  buildReasoningSalvage,
  usableText,
  pushAssistantTurn,
  buildToolSummaryFallback,
  extractSubmittedAnswer,
  type StopReason,
} from "../agent/wrapup.ts";
import { ToolPause } from "./pause.ts";
import type {
  AgentReply,
  AuthorRef,
  ConversationRef,
  HookBus,
  HookEvents,
  HookName,
  Interceptors,
  LanguageModelProvider,
  PendingInteraction,
  ReplySegment,
  ToolActivity,
  ToolContext,
  ToolEntry,
  ToolHosts,
  TurnUsage,
} from "./contracts.ts";

/**
 * The concrete HookBus (built outside src/core) is expected to also expose this — §6 deliberately
 * keeps `emit` off the frozen interface so only the dispatcher calls it. If the wired instance
 * doesn't implement it, hooks are silently skipped rather than throwing.
 */
interface HookEmitter extends HookBus {
  emit?<E extends HookName>(event: E, ctx: Parameters<HookEvents[E]>[0]): void;
}

export function fireHook<E extends HookName>(hooks: HookBus, event: E, ctx: Parameters<HookEvents[E]>[0]): void {
  try {
    (hooks as HookEmitter).emit?.(event, ctx);
  } catch {
    // Observational tier — a throwing hook must never break the turn.
  }
}

const MAX_ITERATIONS = 30;
const BUDGET_WARNING_AT = 5;
const FINAL_WARNING_AT = 2;
const DEFAULT_CONTEXT_RATIO = 0.85;
/** No member of AgentCoreDeps carries the model's absolute context window size (U0 §9 doesn't
 *  expose one on LanguageModelProvider) — falls back to the old config default until a later
 *  unit threads the real value through. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

function isZeroContentResult(r: { finishReason: string; text: string; toolCalls?: unknown[]; usage?: { outputTokens?: number } }): boolean {
  return r.finishReason === "stop" && !r.text && (r.toolCalls?.length ?? 0) === 0 && (r.usage?.outputTokens ?? 0) === 0;
}

export interface LoopDeps {
  model: LanguageModelProvider;
  toModel: (m: LanguageModelProvider) => Parameters<typeof generateText>[0]["model"];
  toolEntries: ToolEntry<keyof ToolHosts>[];
  interceptors?: Interceptors;
  hooks: HookBus;
  contextLimit: number;
  contextRatio?: number;
  maxIterations?: number;
}

export interface LoopRunContext {
  conversation: ConversationRef;
  owner: AuthorRef | null;
  knownUsers: Map<string, AuthorRef>;
  toolContextBase: Omit<ToolContext, "owner">;
  systemPrompt: string;
  /** Drains messages queued mid-loop; returns them so the loop can inject + re-taint ownership. */
  dequeue: () => { author: AuthorRef; text: string }[];
  isCancelled: () => boolean;
  onInterim?: (reply: AgentReply) => Promise<void>;
  onToolsDispatched?: (tools: ToolActivity[]) => void;
}

export interface LoopResult {
  reply: AgentReply;
  messages: ModelMessage[];
  owner: AuthorRef | null;
  pending?: PendingInteraction;
  cancelled: boolean;
}

function toReplySegments(text: string): ReplySegment[] {
  const cleaned = text.replace(/^(\s*---\s*\n)+/, "").replace(/(\n\s*---\s*)+$/, "").trim();
  const parts = cleaned.split(/\n---\n/);
  const segments: ReplySegment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) segments.push({ kind: "separator" });
    const trimmed = part.trim();
    if (trimmed) segments.push({ kind: "text", text: trimmed });
  });
  return segments;
}

function buildAiTools(entries: ToolEntry<keyof ToolHosts>[]): Parameters<typeof generateText>[0]["tools"] {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.name,
      {
        description: entry.definition.description,
        inputSchema: jsonSchema(entry.definition.parameters),
      },
    ]),
  ) as Parameters<typeof generateText>[0]["tools"];
}

/**
 * Runs one turn to completion, pause, or cancellation. Ports `runAgentLoop` (src/agent/loop.ts)
 * onto surface-neutral tools: dispatch goes through `ToolEntry.execute`, output is a structured
 * `AgentReply` instead of a rendered string, and a paused tool signals via `ToolPause` (see
 * pause.ts) instead of a `{tool:"ask_question"}` sentinel result.
 */
export async function runLoop(
  messages: ModelMessage[],
  deps: LoopDeps,
  ctx: LoopRunContext,
): Promise<LoopResult> {
  const maxIterations = deps.maxIterations ?? MAX_ITERATIONS;
  const contextRatio = deps.contextRatio ?? DEFAULT_CONTEXT_RATIO;
  const toolByName = new Map(deps.toolEntries.map((e) => [e.name, e] as const));
  const aiTools = buildAiTools(deps.toolEntries);
  const model = deps.toModel(deps.model);

  let owner = ctx.owner;
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let lastInputTokens = 0;
  let cancelled = false;
  let stopReason: StopReason = "iterations";
  const usedTools: ToolActivity[] = [];

  const ephemeral = new Set<ModelMessage>();
  const pushEphemeral = (msg: ModelMessage) => {
    messages.push(msg);
    ephemeral.add(msg);
  };
  const historyOut = () => messages.filter((m) => !ephemeral.has(m));
  const accumulateUsage = (u: Awaited<ReturnType<typeof generateText>>["usage"] | undefined) => {
    if (!u) return;
    totalInputTokens += u.inputTokens ?? 0;
    totalOutputTokens += u.outputTokens ?? 0;
    totalCacheReadTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
    totalCacheWriteTokens += u.inputTokenDetails?.cacheWriteTokens ?? 0;
    lastInputTokens = u.inputTokens ?? 0;
  };

  const usage = (): TurnUsage => ({
    model: deps.model.modelId,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheWriteTokens: totalCacheWriteTokens,
    contextTokens: lastInputTokens,
    contextLimit: deps.contextLimit,
  });

  const dispatchTools = async (
    toolCalls: { toolCallId: string; toolName: string; input: Record<string, unknown> }[],
  ): Promise<{ toolMessage: ModelMessage; pending?: PendingInteraction }> => {
    const parts: { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }[] = [];
    const paused: { call: (typeof toolCalls)[number]; pending: PendingInteraction }[] = [];

    for (const call of toolCalls) {
      const entry = toolByName.get(call.toolName);
      if (!entry) {
        parts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: `Unknown tool: ${call.toolName}` } });
        continue;
      }

      let input = call.input;
      if (deps.interceptors?.interceptTool) {
        const verdict = await deps.interceptors.interceptTool({
          conversation: ctx.conversation,
          owner,
          tool: call.toolName,
          input,
        });
        if (verdict.block) {
          parts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: verdict.reason ?? "Blocked by policy." } });
          continue;
        }
        if (verdict.input) input = verdict.input;
      }

      try {
        const toolCtx = { ...ctx.toolContextBase, owner } as ToolContext & Required<ToolHosts>;
        const result = await entry.execute(input, toolCtx);
        parts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: result.content } });
      } catch (err) {
        if (err instanceof ToolPause) {
          paused.push({ call, pending: err.pending });
          continue;
        }
        parts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: `Tool error: ${err instanceof Error ? err.message : String(err)}` } });
      }
    }

    // A pausing tool must be called alone — mirrors the old ask_question/automod-approval rule.
    if (paused.length > 0 && toolCalls.length === 1) {
      const { call, pending } = paused[0];
      parts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "Awaiting a response before continuing." } });
      return { toolMessage: { role: "tool", content: parts }, pending };
    }
    for (const { call } of paused) {
      parts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: `${call.toolName} must be called alone — do not combine it with other tool calls in the same turn. Try again with only ${call.toolName}.` } });
    }

    return { toolMessage: { role: "tool", content: parts } };
  };

  while (iterations < maxIterations) {
    if (ctx.isCancelled()) {
      cancelled = true;
      break;
    }
    iterations++;

    for (const queued of ctx.dequeue()) {
      if (owner && (queued.author.userId !== owner.userId || queued.author.surface !== owner.surface)) {
        owner = null;
      }
      if (!ctx.knownUsers.has(queued.author.userId)) {
        ctx.knownUsers.set(queued.author.userId, queued.author);
      }
      messages.push({ role: "user", content: queued.text });
    }

    if (lastInputTokens > deps.contextLimit * contextRatio) {
      stopReason = "context";
      break;
    }

    const stepsLeft = maxIterations - iterations + 1;
    if (stepsLeft === BUDGET_WARNING_AT || stepsLeft === FINAL_WARNING_AT) {
      pushEphemeral({ role: "system", content: buildBudgetWarning(stepsLeft) });
    }

    const result = await generateText({
      model,
      messages: [{ role: "system", content: ctx.systemPrompt, providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } } }, ...messages],
      tools: aiTools,
      maxOutputTokens: 4096,
    });
    const zeroContent = isZeroContentResult(result);
    accumulateUsage(result.usage);

    if (ctx.isCancelled()) {
      cancelled = true;
      break;
    }

    const { text, toolCalls, finishReason } = result;

    if (!toolCalls?.length) {
      if (zeroContent) {
        messages.push({ role: "assistant", content: "(empty response — provider error)" });
      } else {
        pushAssistantTurn(messages, result);
      }
      const displayText = text || (zeroContent ? "The AI provider returned an empty response. Please try again in a moment." : "(no response)");
      return {
        reply: { segments: toReplySegments(displayText), usage: usage(), toolTrace: usedTools, cancelled: false },
        messages: historyOut(),
        owner,
        cancelled: false,
      };
    }

    for (const tc of toolCalls) {
      if (typeof tc.input === "string") {
        try {
          tc.input = JSON.parse(tc.input);
        } catch {
          // Leave as-is; the tool dispatch below reports it downstream.
        }
      }
    }
    const dispatched = toolCalls.map((tc) => ({ name: tc.toolName, input: tc.input as Record<string, unknown> }));
    usedTools.push(...dispatched);
    ctx.onToolsDispatched?.(dispatched);

    if (text && !text.startsWith("[Internal:") && ctx.onInterim) {
      await ctx.onInterim({ segments: toReplySegments(text), usage: usage(), toolTrace: dispatched, cancelled: false });
    }

    messages.push(...result.response.messages);

    const { toolMessage, pending } = await dispatchTools(
      toolCalls as { toolCallId: string; toolName: string; input: Record<string, unknown> }[],
    );
    messages.push(toolMessage);

    if (pending) {
      return {
        reply: { segments: [], usage: usage(), toolTrace: usedTools, cancelled: false },
        messages: historyOut(),
        owner,
        pending,
        cancelled: false,
      };
    }

    void finishReason;
  }

  if (cancelled) {
    return {
      reply: { segments: [], usage: usage(), toolTrace: usedTools, cancelled: true },
      messages: historyOut(),
      owner,
      cancelled: true,
    };
  }

  // Out of budget — funnel into a forced single tool call, same salvage tiers as the old loop.
  let finalText = "";
  let lastReasoningText = "";
  for (let attempt = 0; attempt < 2 && !finalText; attempt++) {
    pushEphemeral({ role: "system", content: attempt === 0 ? WRAP_UP_PROMPT : WRAP_UP_RETRY_PROMPT });
    const finalResult = await generateText({
      model,
      messages: [{ role: "system", content: ctx.systemPrompt }, ...messages],
      tools: {
        [SUBMIT_FINAL_ANSWER_TOOL_NAME]: {
          description: "Deliver your final written answer. This is the only way to respond — call it exactly once with your complete write-up.",
          inputSchema: jsonSchema({
            type: "object",
            properties: { text: { type: "string", description: "The complete answer, following the same evidence/analysis/recommendation format as a normal response." } },
            required: ["text"],
          }),
        },
      },
      toolChoice: { type: "tool", toolName: SUBMIT_FINAL_ANSWER_TOOL_NAME },
      maxOutputTokens: 8192,
    });
    accumulateUsage(finalResult.usage);
    lastReasoningText = finalResult.reasoningText ?? "";
    finalText = usableText(finalResult.text) || extractSubmittedAnswer(finalResult.toolCalls);
    if (finalText) {
      pushAssistantTurn(messages, { text: finalText, toolCalls: finalResult.toolCalls, response: finalResult.response });
    } else {
      pushEphemeral({ role: "assistant", content: WRAP_UP_EMPTY_HISTORY });
    }
  }
  if (!finalText && lastReasoningText) {
    finalText = buildReasoningSalvage(lastReasoningText);
    if (finalText) messages.push({ role: "assistant", content: finalText });
  }
  if (!finalText) {
    finalText = buildToolSummaryFallback(usedTools, stopReason);
    messages.push({ role: "assistant", content: finalText });
  }

  const forcedText = `${finalText}\n\n${buildLimitNote(stopReason)}`;
  return {
    reply: { segments: toReplySegments(forcedText), usage: usage(), toolTrace: usedTools, stoppedEarly: stopReason, cancelled: false },
    messages: historyOut(),
    owner,
    cancelled: false,
  };
}
