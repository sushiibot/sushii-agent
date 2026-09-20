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
import {
  conversationKey,
  type AgentReply,
  type AuthorRef,
  type ConversationRef,
  type HookBus,
  type HookEvents,
  type HookName,
  type Interceptors,
  type LanguageModelProvider,
  type PendingInteraction,
  type ReplySegment,
  type ToolActivity,
  type ToolContext,
  type ToolEntry,
  type ToolHosts,
  type TurnUsage,
} from "./contracts.ts";
import type { ImageSink, KnownUsersSink, PendingInteractionSink } from "./tools/pendingSink.ts";
import "./tools/pendingSink.ts";
import { buildUserNote } from "./prompt.ts";

export function fireHook<E extends HookName>(hooks: HookBus, event: E, ...args: Parameters<HookEvents[E]>): void {
  hooks.emit(event, ...args);
}

const MAX_ITERATIONS = 30;
const BUDGET_WARNING_AT = 5;
const FINAL_WARNING_AT = 2;
const DEFAULT_CONTEXT_RATIO = 0.85;
const MAX_ZERO_RETRIES = 2;
const MAX_NETWORK_RETRIES = 3;

function isZeroContentResult(r: { finishReason: string; text: string; toolCalls?: unknown[]; usage?: { outputTokens?: number } }): boolean {
  return r.finishReason === "stop" && !r.text && (r.toolCalls?.length ?? 0) === 0 && (r.usage?.outputTokens ?? 0) === 0;
}

/** Drops the image part matching `url`, and the containing message if that empties it. Ported
 *  from src/agent/loop.ts — an injected image URL can expire between iterations, and the part
 *  stays in `messages` otherwise, so the provider re-downloads it every step. */
function removeImagePart(messages: ModelMessage[], url: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const kept = msg.content.filter((part) => !(part.type === "image" && String(part.image) === url));
    if (kept.length === msg.content.length) continue;
    if (kept.length === 0) messages.splice(i, 1);
    else msg.content = kept;
    return true;
  }
  return false;
}

export interface LoopDeps {
  model: LanguageModelProvider;
  toModel: (m: LanguageModelProvider) => Parameters<typeof generateText>[0]["model"];
  toolEntries: ToolEntry<keyof ToolHosts>[];
  interceptors?: Interceptors;
  hooks: HookBus;
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
 * `AgentReply` instead of a rendered string, and a paused tool signals by pushing to `ctx.pending`
 * (pendingSink.ts) instead of a `{tool:"ask_question"}` sentinel result.
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
    contextLimit: deps.model.contextLimit,
  });

  // Shared sinks for the whole turn (contracts.ts §7 augmentation, pendingSink.ts). `pending`
  // itself is captured per-call below so a batch-level pause can be traced back to the one tool
  // call that requested it — everything else is pooled across the batch.
  const imageUrls: string[] = [];
  const imagesSink: ImageSink = { push: (urls) => imageUrls.push(...urls) };
  const novelUsers: AuthorRef[] = [];
  const knownUsersSink: KnownUsersSink = {
    add: (userId, names) => {
      if (ctx.knownUsers.has(userId)) return;
      const author: AuthorRef = { surface: ctx.conversation.surface, userId, username: names.username, displayName: names.displayName };
      ctx.knownUsers.set(userId, author);
      novelUsers.push(author);
    },
  };

  const dispatchTools = async (
    toolCalls: { toolCallId: string; toolName: string; input: Record<string, unknown> }[],
  ): Promise<{ toolMessage: ModelMessage; pending?: PendingInteraction }> => {
    const paused: { call: (typeof toolCalls)[number]; pending: PendingInteraction }[] = [];

    const runOne = async (call: (typeof toolCalls)[number]): Promise<{ call: (typeof toolCalls)[number]; value: string }> => {
      const entry = toolByName.get(call.toolName);
      if (!entry) return { call, value: `Unknown tool: ${call.toolName}` };

      let input = call.input;
      if (deps.interceptors?.interceptTool) {
        const verdict = await deps.interceptors.interceptTool({
          conversation: ctx.conversation,
          owner,
          tool: call.toolName,
          input,
        });
        if (verdict.block) return { call, value: verdict.reason ?? "Blocked by policy." };
        if (verdict.input) input = verdict.input;
      }

      // Per-call sink so a batch-level pause is attributable to this exact call — see the
      // enforceCalledAlone rule below, ported from src/modules/moderation/executor.ts.
      let callPending: PendingInteraction | undefined;
      const pendingSink: PendingInteractionSink = { push: (p) => { if (!callPending) callPending = p; } };

      try {
        const toolCtx = { ...ctx.toolContextBase, owner, pending: pendingSink, images: imagesSink, knownUsers: knownUsersSink } as ToolContext & Required<ToolHosts>;
        const result = await entry.execute(input, toolCtx);
        if (callPending) {
          paused.push({ call, pending: callPending });
          return { call, value: "Awaiting a response before continuing." };
        }
        return { call, value: result.content };
      } catch (err) {
        return { call, value: `Tool error: ${err instanceof Error ? err.message : String(err)}` };
      }
    };

    // timeout_member must land before delete_user_messages — otherwise the offending user can
    // keep posting new messages while deletion is still in flight. Ported from executor.ts.
    const timeoutCalls = toolCalls.filter((c) => c.toolName === "timeout_member");
    const otherCalls = toolCalls.filter((c) => c.toolName !== "timeout_member");
    const timeoutResults = await Promise.all(timeoutCalls.map(runOne));
    const otherResults = await Promise.all(otherCalls.map(runOne));
    const resultByCallId = new Map([...timeoutResults, ...otherResults].map((r) => [r.call.toolCallId, r] as const));

    const parts: { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }[] = toolCalls.map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "text", value: resultByCallId.get(call.toolCallId)!.value },
    }));

    // A pausing tool must be called alone — mirrors the old ask_question/automod-approval rule.
    if (paused.length > 0 && toolCalls.length === 1) {
      return { toolMessage: { role: "tool", content: parts }, pending: paused[0].pending };
    }
    for (const { call } of paused) {
      const idx = parts.findIndex((p) => p.toolCallId === call.toolCallId);
      parts[idx] = {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: `${call.toolName} must be called alone — do not combine it with other tool calls in the same turn. Try again with only ${call.toolName}.` },
      };
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

    if (lastInputTokens > deps.model.contextLimit * contextRatio) {
      stopReason = "context";
      break;
    }

    const stepsLeft = maxIterations - iterations + 1;
    if (stepsLeft === BUDGET_WARNING_AT || stepsLeft === FINAL_WARNING_AT) {
      pushEphemeral({ role: "system", content: buildBudgetWarning(stepsLeft) });
    }

    const generateParams = (): Parameters<typeof generateText>[0] => ({
      model,
      messages: [{ role: "system", content: ctx.systemPrompt, providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } } }, ...messages],
      tools: aiTools,
      maxOutputTokens: 4096,
      experimental_telemetry: {
        isEnabled: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
        functionId: "agent-loop",
        // Do not export prompt/response content (user messages) to the OTel backend — IDs only.
        recordInputs: false,
        recordOutputs: false,
        metadata: { conversationKey: conversationKey(ctx.conversation), surface: ctx.conversation.surface },
      },
    });

    // Network-retry / vision-fallback resilience, ported from src/agent/loop.ts. Mutates
    // `messages` in place (image-part removal, vision fallback) so a retried generateParams()
    // call picks up the fix.
    let result = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await generateText(generateParams());
        } catch (err) {
          // An injected image URL can expire between iterations; drop just the dead part.
          if (err instanceof Error && err.name === "AI_DownloadError") {
            const deadUrl = (err as Error & { url?: string }).url;
            const removed = deadUrl ? removeImagePart(messages, deadUrl) : false;
            if (!removed) throw err;
            pushEphemeral({
              role: "system",
              content: "One of the attached images could not be loaded — its Discord CDN link expired. Re-fetch it with inspect_image using channel_id + message_id, or continue without it and say so to the moderator.",
            });
            continue;
          }

          const isSocketError = err instanceof Error && err.name === "AI_APICallError" && err.message.includes("socket connection was closed");
          if (!isSocketError) throw err;

          // Pure-image user message in context indicates vision is unsupported. Scan backward
          // rather than checking the tail — steering notes are appended after image injection.
          let imageIdx = -1;
          for (let i = messages.length - 1; i >= 0 && imageIdx === -1; i--) {
            const m = messages[i];
            if (m.role === "user" && Array.isArray(m.content) && m.content.length > 0 && m.content.every((c: { type: string }) => c.type === "image")) {
              imageIdx = i;
            }
          }

          if (imageIdx !== -1) {
            messages.splice(imageIdx, 1);
            messages.push({
              role: "system",
              content: "The image(s) attached to this message could not be processed — this model does not support vision. Proceed without the image content and note this limitation to the moderator.",
            });
            return await generateText(generateParams());
          }

          if (attempt < MAX_NETWORK_RETRIES) {
            if (ctx.isCancelled()) throw err;
            await new Promise<void>((r) => setTimeout(r, 1000 * 2 ** attempt));
            if (ctx.isCancelled()) throw err;
            continue;
          }
          throw err;
        }
      }
    })();

    let zeroContent = isZeroContentResult(result);
    for (let attempt = 0; attempt < MAX_ZERO_RETRIES && zeroContent; attempt++) {
      // Accumulate tokens from the discarded retry attempt before overwriting result.
      accumulateUsage(result.usage);
      if (ctx.isCancelled()) {
        cancelled = true;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, 500 * 2 ** attempt));
      if (ctx.isCancelled()) {
        cancelled = true;
        break;
      }
      result = await generateText(generateParams());
      zeroContent = isZeroContentResult(result);
    }
    if (cancelled) break;
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

    if (imageUrls.length > 0) {
      // Ephemeral: the signed CDN URLs are dead by the next turn, so persisting them would
      // re-download a broken link on every future generate. The model's own text is the record.
      pushEphemeral({ role: "user", content: imageUrls.splice(0).map((url) => ({ type: "image" as const, image: url })) });
    }

    if (novelUsers.length > 0) {
      messages.push({ role: "system", content: buildUserNote(novelUsers.splice(0)) });
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
      experimental_telemetry: {
        isEnabled: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
        functionId: "agent-loop-wrapup",
        recordInputs: false,
        recordOutputs: false,
        metadata: { conversationKey: conversationKey(ctx.conversation), surface: ctx.conversation.surface },
      },
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
