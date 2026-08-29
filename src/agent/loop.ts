import type { ModelMessage } from "ai";
import { generateText, jsonSchema } from "ai";
import type { Client } from "discord.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { openaiProvider } from "./client.ts";
import { config } from "../config.ts";
import { getLogger } from "../logger.ts";
import { buildToolsForGuild, type ModuleId, type ToolEntry } from "../modules/registry.ts";
import { runTools, type UserNames, type PendingAutomodApproval, type PendingAutomodDeletion } from "../modules/moderation/executor.ts";
import { AUTO_MOD_ONLY_TOOLS, EXA_TOOLS } from "../modules/moderation/tools.ts";
import { renderModelText } from "../utils/discordText.ts";
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
} from "./wrapup.ts";

const logger = getLogger("agent");

const tracer = trace.getTracer("sushii-agent");

export function resolveToolEntries(enabledModules: ModuleId[], autoModMode = false): ToolEntry[] {
  return buildToolsForGuild(enabledModules)
    .filter((entry) => autoModMode || !AUTO_MOD_ONLY_TOOLS.has(entry.name))
    .filter((entry) => config.exaApiKey || !EXA_TOOLS.has(entry.name));
}

function buildAiTools(toolEntries: ToolEntry[]): Parameters<typeof generateText>[0]["tools"] {
  return Object.fromEntries(
    toolEntries.map((entry) => [
      entry.name,
      {
        description: entry.definition.function.description,
        inputSchema: jsonSchema(entry.definition.function.parameters as Record<string, unknown>),
      },
    ]),
  ) as Parameters<typeof generateText>[0]["tools"];
}

const MAX_ITERATIONS = 30;
const BUDGET_WARNING_AT = 5;
const FINAL_WARNING_AT = 2;
const CONTEXT_BUDGET_RATIO = 0.85;
const MAX_ZERO_RETRIES = 2;
const MAX_NETWORK_RETRIES = 3;

const ZERO_CONTENT_HISTORY = "(empty response — provider error)";
const ZERO_CONTENT_USER_MSG = "The AI provider returned an empty response. Please try again in a moment.";

function isZeroContentResult(r: { finishReason: string; text: string; toolCalls?: unknown[]; usage?: { outputTokens?: number } }): boolean {
  return (
    r.finishReason === "stop" &&
    !r.text &&
    (r.toolCalls?.length ?? 0) === 0 &&
    (r.usage?.outputTokens ?? 0) === 0
  );
}

export interface TriggeringUser {
  id: string;
  username: string;
  displayName?: string | null;
  roles: { id: string; name: string }[];
  isModerator: boolean;
}

export interface ChannelContext {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  topic?: string | null;
  categoryName?: string | null;
  parentChannelId?: string | null;
  parentChannelName?: string | null;
}

export interface AutoModTriggerContext {
  reporterUserId: string;
  reporterUsername: string;
  incidentChannelId: string;
  incidentChannelName: string;
  triggerMessageContent: string;
  triggerMessageId: string;
  repliedToUserId?: string;
  repliedToMessageId?: string;
  modRoleId: string;
  modImmuneRoleIds: string[];
  newMemberThresholdDays: number;
  /** ID of the silent anchor message send_alert_message edits in place to deliver the final ping. */
  anchorMessageId: string;
}

export interface AgentLoopOptions {
  /** Additional module-supplied prompt sections appended after the generic ones (e.g. moderation's auto-mod block). */
  extraPromptSections?: string[];
  threadContext?: string;
  currentChannelId?: string;
  emojiMap?: Record<string, string>;
  mentionedUsers?: Map<string, UserNames>;
  botId?: string;
  botUsername?: string;
  triggeringUser?: TriggeringUser;
  currentChannel?: ChannelContext;
  serverContext?: string | null;
  memoryIndex?: string[]; // titles only — agent fetches content via read_memory
  memoryCount?: number;
  memoryLimit?: number;
  onInterimText?: (text: string) => Promise<void>;
  /** Called each iteration with the current batch of tool calls being dispatched. When provided, tool lines are omitted from the final footer. */
  onToolsDispatched?: (tools: { name: string; input: Record<string, unknown> }[]) => Promise<void>;
  /** Called before each generateText call to drain messages queued mid-loop by the user. */
  dequeueMessages?: () => { query: string; mentionedUsers?: Map<string, UserNames> }[];
  /** Called before each iteration; return true to abort the loop early. */
  isCancelled?: () => boolean;
  /** When set, switches the agent into autonomous auto-mod enforcement mode. */
  autoModTrigger?: AutoModTriggerContext;
}

export type { UserNames };

/** Drops the image part matching `url`, and the containing message if that empties it. */
function removeImagePart(messages: ModelMessage[], url: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const kept = msg.content.filter(
      (part) => !(part.type === "image" && String(part.image) === url),
    );
    if (kept.length === msg.content.length) continue;
    if (kept.length === 0) messages.splice(i, 1);
    else msg.content = kept;
    return true;
  }
  return false;
}

function buildUserNote(novel: [string, UserNames][]): string {
  const lines = novel.map(([id, names]) => {
    const parts = [names.username, names.displayName].filter(Boolean);
    return `• u:${id} = ${parts.join(" / ") || "(unknown)"}`;
  });
  return `[Internal: user identity mappings for resolving names — do not quote or surface this to the user]\n${lines.join("\n")}`;
}

export function buildSystemPrompt(behaviorInstructions: string, opts: AgentLoopOptions = {}): string {
  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const systemParts = [behaviorInstructions, `Current date: ${currentDate}. Use this only for interpreting relative time references in user messages (e.g. "yesterday", "last week"). Do NOT use it to compute or write timestamp math in your responses — always use Discord timestamp format instead.`];

  // Bot's own identity
  if (opts.botId) {
    const nameStr = opts.botUsername ? ` (${opts.botUsername})` : "";
    systemParts.push(`Your identity: Your Discord user ID is ${opts.botId}${nameStr}. When you see u:${opts.botId} in messages, that is yourself. Never confuse your own messages with those of other users.`);
  }

  // Current channel context
  if (opts.currentChannel) {
    const ch = opts.currentChannel;
    const privacy = ch.isPrivate ? "private (not visible to regular members)" : "public";
    const lines = [`Current channel: #${ch.name} (c:${ch.id}) — ${ch.type}, ${privacy}`];
    if (ch.categoryName) lines.push(`Category: ${ch.categoryName}`);
    if (ch.parentChannelName) lines.push(`Parent channel: #${ch.parentChannelName}`);
    if (ch.topic) lines.push(`Topic: ${ch.topic}`);
    systemParts.push(lines.join("\n"));
  }

  // Triggering user context
  if (opts.triggeringUser) {
    const u = opts.triggeringUser;
    const displayStr = u.displayName && u.displayName !== u.username ? ` (display name: ${u.displayName})` : "";
    const modStr = u.isModerator ? "yes — has moderation role" : "no";
    const roleStr = u.roles.length > 0
      ? u.roles.map((r) => `${r.name} (${r.id})`).join(", ")
      : "none";
    const lines = [
      `Request from: ${u.username}${displayStr} (u:${u.id})`,
      `Moderator: ${modStr}`,
      `Roles: ${roleStr}`,
    ];
    systemParts.push(lines.join("\n"));
  }

  // Server context (always injected, full content)
  if (opts.serverContext) {
    systemParts.push(`## Server Context\n${opts.serverContext}`);
  } else if (opts.serverContext === null) {
    systemParts.push(
      `## Server Context\nNot configured. At the start of this conversation, let the moderator know and suggest they type \`scan server\` so you can learn the server structure. You can still help with queries, but your awareness of this server will be limited until the scan is done. When scanning, identify the channel that holds the server rules and record only its channel ID under server context — never the rule text itself, which can change independently.`,
    );
  }

  // Memory index (titles only — agent fetches full content via read_memory when relevant)
  if (opts.memoryIndex !== undefined) {
    const limit = opts.memoryLimit ?? 25;
    const count = opts.memoryCount ?? opts.memoryIndex.length;
    const header = `## Agent Memory (${count}/${limit} entries)`;
    const body =
      opts.memoryIndex.length > 0
        ? opts.memoryIndex.map((t, i) => `${i + 1}. "${t}"`).join("\n")
        : "(empty)";
    systemParts.push(
      `${header}\nCheck this index at the start of each conversation. If any entries look relevant to the current query, call read_memory to fetch their content before proceeding. See the memory tool description for what to write and what to leave to live lookups.\n\n${body}`,
    );
  }

  if (opts.emojiMap && Object.keys(opts.emojiMap).length > 0) {
    const entries = Object.entries(opts.emojiMap)
      .map(([name]) => `e:${name}`)
      .join("  ");
    systemParts.push(
      `Server emojis — use as \`e:name\` tokens (e.g. \`e:JennieLmao2\`). Available:\n${entries}\nDo not use other emojis. Do not include angle brackets or IDs — the bot expands \`e:name\` to the correct Discord syntax automatically.`,
    );
  }

  if (opts.threadContext) {
    const channelNote = opts.currentChannelId
      ? `\nThread channel ID: ${opts.currentChannelId} — if the thread has more history than shown above, use fetch_channel_messages with this channel_id and before=<earliest_message_id_above> to retrieve older messages.`
      : "";
    systemParts.push(`Current thread messages (all participants including bots, excluding your own prior replies):${channelNote}\n\n${opts.threadContext}`);
  }

  // Module-supplied prompt sections (e.g. moderation's auto-mod autonomous-enforcement
  // block, built by moderation/prompt.ts's buildAutoModPromptSection) — the generic loop
  // has no branch that knows about any specific module's prompt content.
  if (opts.extraPromptSections?.length) {
    systemParts.push(...opts.extraPromptSections);
  }

  return systemParts.join("\n\n---\n\n");
}

export interface PendingQuestion {
  question: string;
  choices: string[];
}

export interface AgentLoopResult {
  response: string;
  updatedHistory: ModelMessage[];
  pendingQuestion?: PendingQuestion;
  pendingAutomodApproval?: PendingAutomodApproval;
  pendingAutomodDeletion?: PendingAutomodDeletion;
  cancelled: boolean;
}

export type { PendingAutomodApproval, PendingAutomodDeletion };

export async function runAgentLoop(
  query: string,
  existingHistory: ModelMessage[],
  guildId: string,
  client: Client<true>,
  enabledModules: ModuleId[],
  behaviorInstructions: string,
  opts: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  return tracer.startActiveSpan("agent.loop", {
    attributes: {
      "agent.model": config.openaiModel,
      "agent.history_length": existingHistory.length,
      "agent.guild_id": guildId,
      ...(opts.currentChannelId && { "discord.thread_id": opts.currentChannelId }),
    },
  }, async (span) => {
    const log = logger.child({ threadId: opts.currentChannelId, guildId });
    const systemPrompt = buildSystemPrompt(behaviorInstructions, opts);

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: systemPrompt,
        // Cache the system prompt — it's the largest static block and identical
        // across all iterations within a single agent loop run.
        providerOptions: {
          openrouter: { cacheControl: { type: "ephemeral" } },
        },
      },
      ...existingHistory,
    ];

    const knownUsers = new Map<string, UserNames>();

    // Seed knownUsers from ALL system messages in existing history so we don't re-inject
    // identity notes for users already noted in prior turns — both mentionedUsers and
    // tool-discovered users (whose IDs appear as <@id> in [Internal: user identity mappings] notes).
    for (const msg of messages) {
      if (msg.role !== "system") continue;
      const text = typeof msg.content === "string" ? msg.content : null;
      if (!text) continue;
      for (const [, id] of text.matchAll(/<@(\d+)>/g)) {
        if (!knownUsers.has(id)) {
          knownUsers.set(id, opts.mentionedUsers?.get(id) ?? { username: "(unknown)", displayName: null });
        }
      }
    }

    if (opts.mentionedUsers?.size) {
      const novel = [...opts.mentionedUsers.entries()].filter(([id]) => !knownUsers.has(id));
      if (novel.length > 0) {
        for (const [id, userNames] of novel) knownUsers.set(id, userNames);
        messages.push({ role: "system", content: buildUserNote(novel) });
        log.debug({ count: novel.length }, "injected mention user note");
      }
    }

    messages.push({ role: "user", content: query });

    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let lastInputTokens = 0;
    let cancelled = false;
    let stopReason: StopReason = "iterations";
    const usedTools: { name: string; input: Record<string, unknown> }[] = [];
    // Step-budget nudges steer this run only — persisting them would make the next turn
    // believe it is already out of steps and must not use tools.
    const ephemeral = new Set<ModelMessage>();
    const pushEphemeral = (msg: ModelMessage) => {
      messages.push(msg);
      ephemeral.add(msg);
    };
    const historyOut = () => messages.slice(1).filter((m) => !ephemeral.has(m));
    const accumulateUsage = (u: Awaited<ReturnType<typeof generateText>>["usage"] | undefined) => {
      if (!u) return;
      totalInputTokens += u.inputTokens ?? 0;
      totalOutputTokens += u.outputTokens ?? 0;
      totalCacheReadTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
      totalCacheWriteTokens += u.inputTokenDetails?.cacheWriteTokens ?? 0;
      lastInputTokens = u.inputTokens ?? 0;
    };
    log.info({ historyLength: existingHistory.length, knownUsers: knownUsers.size }, "starting loop");

    // Constant for the whole run — enabledModules and auto-mod mode don't change mid-loop —
    // so this doubles as both the LLM-advertised tool list and the dispatch table runTools
    // resolves calls through, keeping the two in lockstep.
    const toolEntries = resolveToolEntries(enabledModules, !!opts.autoModTrigger);

    try {
      while (iterations < MAX_ITERATIONS) {
        if (opts.isCancelled?.()) {
          cancelled = true;
          log.info({ iteration: iterations }, "loop cancelled by user");
          break;
        }

        iterations++;
        log.debug({ iteration: iterations }, "iteration");

        // Inject any messages queued by the user while the previous iteration was running
        if (opts.dequeueMessages) {
          const pending = opts.dequeueMessages();
          for (const { query: pendingQuery, mentionedUsers: pendingUsers } of pending) {
            if (pendingUsers?.size) {
              const novel = [...pendingUsers.entries()].filter(([id]) => !knownUsers.has(id));
              if (novel.length > 0) {
                for (const [id, names] of novel) knownUsers.set(id, names);
                messages.push({ role: "system", content: buildUserNote(novel) });
              }
            }
            messages.push({ role: "user", content: pendingQuery });
            log.info({ query: pendingQuery.slice(0, 80) }, "injected mid-loop message");
          }
        }

        // Stop before the provider rejects the request outright — an overflow throws out of the
        // loop and the caller discards the whole run, so degrade into the wrap-up instead.
        if (lastInputTokens > config.openaiContextLimit * CONTEXT_BUDGET_RATIO) {
          stopReason = "context";
          log.warn({ iteration: iterations, lastInputTokens, limit: config.openaiContextLimit }, "context budget exhausted, forcing final response");
          break;
        }

        const stepsLeft = MAX_ITERATIONS - iterations + 1;
        if (stepsLeft === BUDGET_WARNING_AT || stepsLeft === FINAL_WARNING_AT) {
          pushEphemeral({ role: "system", content: buildBudgetWarning(stepsLeft) });
          log.info({ iteration: iterations, stepsLeft }, "injected step budget warning");
        }

        const generateParams: Parameters<typeof generateText>[0] = {
          model: openaiProvider(config.openaiModel),
          messages,
          tools: buildAiTools(toolEntries),
          maxOutputTokens: 4096,
          experimental_telemetry: {
            isEnabled: true,
            recordInputs: false,
            recordOutputs: false,
            functionId: "agent-loop",
            metadata: { guildId, iteration: iterations, retry: 0 },
          },
          providerOptions: {
            openrouter: {
              provider: { data_collection: "deny" },
              ...(opts.currentChannelId ? { session_id: opts.currentChannelId } : {}),
            },
          },
        };

        // Retry on zero-content stop responses (OpenRouter cold-start / scaling events).
        // These return finishReason "stop" with no text, no tool calls, and 0 output tokens.
        // The SDK can't detect them as errors since they're valid 200 OK responses.
        // Handle two failure modes the SDK marks as non-retryable (AI_APICallError on 200 OK):
        // 1. Model doesn't support vision: images in context → strip them and continue
        // 2. Genuine transient socket drop: retry with exponential backoff
        let result = await (async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await generateText(generateParams);
            } catch (err) {
              // An injected image URL can expire between iterations, and the part stays in `messages`,
              // so the provider re-downloads it every step. Drop just the dead part and keep going.
              if (err instanceof Error && err.name === "AI_DownloadError") {
                const deadUrl = (err as Error & { url?: string }).url;
                const removed = deadUrl ? removeImagePart(messages, deadUrl) : false;
                log.warn({ iteration: iterations, deadUrl, removed }, "image download failed, dropping image from context");
                if (!removed) throw err;
                pushEphemeral({
                  role: "system",
                  content: "One of the attached images could not be loaded — its Discord CDN link expired. Re-fetch it with inspect_image using channel_id + message_id, or continue without it and say so to the moderator.",
                });
                continue;
              }

              const isSocketError =
                err instanceof Error &&
                err.name === "AI_APICallError" &&
                err.message.includes("socket connection was closed");
              if (!isSocketError) throw err;

              // Pure-image user message in context indicates vision is unsupported. Scan backward
              // rather than checking the tail — steering notes are appended after image injection.
              let imageIdx = -1;
              for (let i = messages.length - 1; i >= 0 && imageIdx === -1; i--) {
                const m = messages[i];
                if (
                  m.role === "user" &&
                  Array.isArray(m.content) &&
                  m.content.length > 0 &&
                  m.content.every((c: { type: string }) => c.type === "image")
                ) {
                  imageIdx = i;
                }
              }

              if (imageIdx !== -1) {
                // Strip the unsupported image message and substitute a plain-text fallback
                messages.splice(imageIdx, 1);
                messages.push({
                  role: "system",
                  content: "The image(s) attached to this message could not be processed — this model does not support vision. Proceed without the image content and note this limitation to the moderator.",
                });
                log.warn({ iteration: iterations }, "model does not support images, substituting text fallback");
                return await generateText(generateParams);
              }

              if (attempt < MAX_NETWORK_RETRIES) {
                log.warn({ iteration: iterations, attempt: attempt + 1, err }, "transient network error from provider, retrying");
                if (opts.isCancelled?.()) throw err;
                await new Promise<void>((r) => setTimeout(r, 1000 * 2 ** attempt));
                if (opts.isCancelled?.()) throw err;
                continue;
              }
              throw err;
            }
          }
        })();
        let zeroContent = isZeroContentResult(result);
        for (let attempt = 0; attempt < MAX_ZERO_RETRIES && zeroContent; attempt++) {
          // Accumulate tokens from the discarded retry attempt before overwriting result
          accumulateUsage(result.usage);
          log.warn({ iteration: iterations, retry: attempt + 1 }, "zero-content response from provider, retrying");
          if (opts.isCancelled?.()) {
            cancelled = true;
            break;
          }
          await new Promise<void>((r) => setTimeout(r, 500 * 2 ** attempt));
          if (opts.isCancelled?.()) {
            cancelled = true;
            break;
          }
          result = await generateText({
            ...generateParams,
            experimental_telemetry: {
              isEnabled: true,
              recordInputs: false,
              recordOutputs: false,
              functionId: "agent-loop",
              metadata: { guildId, iteration: iterations, retry: attempt + 1 },
            },
          });
          zeroContent = isZeroContentResult(result);
        }
        if (cancelled) break;

        const { text, toolCalls, finishReason, usage } = result;

        if (usage) {
          accumulateUsage(usage);
          log.debug({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.inputTokenDetails?.cacheReadTokens, cacheWrite: usage.inputTokenDetails?.cacheWriteTokens }, "tokens");
        }

        if (opts.isCancelled?.()) {
          cancelled = true;
          log.info({ iteration: iterations }, "loop cancelled by user (post-generation)");
          break;
        }

        // Dispatch on the presence of tool calls, not on finishReason. This provider has been seen
        // returning "stop" alongside real tool calls; keying off finishReason silently dropped them
        // and left the user with whatever text came back, usually nothing.
        if (!toolCalls?.length) {
          if (finishReason !== "stop") {
            log.warn({ finishReason }, "unexpected finish_reason with no tool calls, treating as final");
          }
          if (zeroContent) {
            messages.push({
              role: "assistant",
              content: ZERO_CONTENT_HISTORY,
            });
          } else {
            pushAssistantTurn(messages, result);
          }
          const displayText = text
            || (zeroContent
              ? ZERO_CONTENT_USER_MSG
              : "(no response)");
          const content = renderModelText(displayText, { guildId, emojiMap: opts.emojiMap });
          const footerTools = opts.onToolsDispatched ? [] : usedTools;
          const footer = buildFooter(config.openaiModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, lastInputTokens, config.openaiContextLimit, footerTools);
          log.info({ iterations, responseLength: content.length }, "done");
          return { response: `${content}\n\n---\n${footer}`, updatedHistory: historyOut(), cancelled: false };
        }

        {
          const names = toolCalls.map((t) => t.toolName).join(", ");
          log.debug({ tools: names, finishReason }, "tool calls");
          // Some providers occasionally emit tool-call arguments as an unparsed JSON string
          // instead of an object; normalize here so it isn't spread into a char-indexed object downstream.
          for (const tc of toolCalls) {
            if (typeof tc.input === "string") {
              try {
                tc.input = JSON.parse(tc.input);
              } catch {
                log.warn({ tool: tc.toolName, input: tc.input }, "tool call input was unparseable JSON string");
              }
            }
          }
          const dispatchedTools = toolCalls.map((tc) => ({ name: tc.toolName, input: tc.input as Record<string, unknown> }));
          for (const tool of dispatchedTools) {
            usedTools.push(tool);
          }

          if (opts.onToolsDispatched) {
            await opts.onToolsDispatched(dispatchedTools);
          }

          if (text && !text.startsWith("[Internal:") && opts.onInterimText) {
            await opts.onInterimText(renderModelText(text, { guildId, emojiMap: opts.emojiMap }));
          }

          // Add assistant message with tool calls to history (preserves reasoning_content for thinking models)
          messages.push(...result.response.messages);

          const { toolMessage, discoveredUsers, pendingImages, pendingQuestion, pendingAutomodApproval, pendingAutomodDeletion } = await tracer.startActiveSpan(
            "agent.tool_calls",
            { attributes: { "agent.tools": names, "agent.iteration": iterations } },
            async (toolSpan) => {
              try {
                return await runTools(toolCalls as { toolCallId: string; toolName: string; input: Record<string, unknown> }[], guildId, client, toolEntries, opts.autoModTrigger, log, opts.triggeringUser?.id);
              } finally {
                toolSpan.end();
              }
            },
          );

          messages.push(toolMessage);

          // ask_question — pause loop and return to let the bot send buttons
          if (pendingQuestion) {
            log.info({ question: pendingQuestion.question }, "pausing loop for ask_question");
            span.setAttribute("agent.paused_for_question", true);
            return { response: "", updatedHistory: historyOut(), pendingQuestion, cancelled: false };
          }

          // add_automod_keyword — pause loop and return to let the bot send approval buttons
          if (pendingAutomodApproval) {
            log.info({ ruleId: pendingAutomodApproval.ruleId, keyword: pendingAutomodApproval.keyword }, "pausing loop for automod keyword approval");
            span.setAttribute("agent.paused_for_automod_approval", true);
            return { response: "", updatedHistory: historyOut(), pendingAutomodApproval, cancelled: false };
          }

          // delete_automod_keyword — pause loop and return to let the bot send deletion approval buttons
          if (pendingAutomodDeletion) {
            log.info({ ruleId: pendingAutomodDeletion.ruleId, keyword: pendingAutomodDeletion.keyword }, "pausing loop for automod keyword deletion approval");
            span.setAttribute("agent.paused_for_automod_deletion", true);
            return { response: "", updatedHistory: historyOut(), pendingAutomodDeletion, cancelled: false };
          }

          if (pendingImages.length > 0) {
            // Ephemeral: the signed CDN URLs are dead by the next turn, so persisting them would
            // re-download a broken link on every future generate. The model's own text is the record.
            pushEphemeral({
              role: "user",
              content: pendingImages.map((url) => ({ type: "image" as const, image: url })),
            });
            log.debug({ count: pendingImages.length }, "injected images for inspection");
          }

          const novel = [...discoveredUsers.entries()].filter(([id]) => !knownUsers.has(id));
          if (novel.length > 0) {
            for (const [id, userNames] of novel) knownUsers.set(id, userNames);
            messages.push({ role: "system", content: buildUserNote(novel) });
            log.debug({ count: novel.length }, "injected user note for new users");
          }

          continue;
        }
      }

      if (cancelled) {
        return { response: "", updatedHistory: historyOut(), cancelled: true };
      }

      // Out of budget — inject a wrap-up prompt and funnel the model into a single forced tool
      // call instead of fighting its bias toward tool calls. After ~30 tool-call/tool-result
      // turns the model copies that pattern regardless of what's in `tools`, so suppressing tools
      // entirely just produced empty `tool-calls` finishes with no text and no result. Give it one
      // tool it can't miss.
      log.warn({ iterations, stopReason }, "agent loop out of budget, forcing final response");
      let finalText = "";
      let lastReasoningText = "";
      let wrapupTier: "funnel" | "reasoning" | "toolSummary" = "toolSummary";
      for (let attempt = 0; attempt < 2 && !finalText; attempt++) {
        pushEphemeral({ role: "system", content: attempt === 0 ? WRAP_UP_PROMPT : WRAP_UP_RETRY_PROMPT });
        const finalResult = await generateText({
          model: openaiProvider(config.openaiModel),
          messages,
          tools: {
            [SUBMIT_FINAL_ANSWER_TOOL_NAME]: {
              description: "Deliver your final written answer to the moderator. This is the only way to respond — call it exactly once with your complete write-up.",
              inputSchema: jsonSchema({
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "The complete answer for the moderator, following the same evidence/analysis/recommendation format as a normal response.",
                  },
                },
                required: ["text"],
              }),
            },
          },
          toolChoice: { type: "tool", toolName: SUBMIT_FINAL_ANSWER_TOOL_NAME },
          maxOutputTokens: 8192,
          experimental_telemetry: {
            isEnabled: true,
            recordInputs: false,
            recordOutputs: false,
            functionId: "agent-loop",
            metadata: { guildId, iteration: iterations, forced: true, retry: attempt },
          },
          providerOptions: {
            openrouter: {
              provider: { data_collection: "deny" },
              ...(opts.currentChannelId ? { session_id: opts.currentChannelId } : {}),
            },
          },
        });
        accumulateUsage(finalResult.usage);
        lastReasoningText = finalResult.reasoningText ?? "";
        // The AI SDK never throws on a malformed submit_final_answer call — parseToolCall catches
        // JSON/schema failures and returns the call with invalid:true and input set to the raw
        // string instead. extractSubmittedAnswer handles that shape directly.
        finalText = usableText(finalResult.text) || extractSubmittedAnswer(finalResult.toolCalls);
        const toolNames = finalResult.toolCalls?.map((t) => t.toolName) ?? [];
        const anyInvalid = finalResult.toolCalls?.some((t) => (t as { invalid?: boolean }).invalid) ?? false;
        log.info(
          {
            attempt,
            finishReason: finalResult.finishReason,
            textLength: finalText.length,
            rawTextLength: finalResult.text.length,
            toolNames,
            invalid: anyInvalid,
            submittedLength: finalText.length,
            reasoningLength: finalResult.reasoningText?.length ?? 0,
          },
          "forced final response",
        );
        if (finalText) {
          wrapupTier = "funnel";
          pushAssistantTurn(messages, {
            text: finalText,
            toolCalls: finalResult.toolCalls,
            response: finalResult.response,
          });
        } else {
          // Give the retry prompt a referent — without this the model sees two consecutive
          // system messages complaining about a reply that isn't in its context.
          pushEphemeral({ role: "assistant", content: WRAP_UP_EMPTY_HISTORY });
        }
      }
      if (!finalText && lastReasoningText) {
        finalText = buildReasoningSalvage(lastReasoningText);
        if (finalText) {
          wrapupTier = "reasoning";
          messages.push({ role: "assistant", content: finalText });
          log.warn({ iterations }, "forced final response salvaged from reasoning text");
        }
      }
      if (!finalText) {
        finalText = buildToolSummaryFallback(usedTools, stopReason);
        messages.push({ role: "assistant", content: finalText });
        log.warn({ iterations }, "forced final response produced no text, using tool summary fallback");
      }
      log.info({ iterations, wrapupTier }, "wrap-up tier resolved");
      const forcedContent = `${renderModelText(finalText, { guildId, emojiMap: opts.emojiMap })}\n\n${buildLimitNote(stopReason)}`;
      const footer = buildFooter(config.openaiModel, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, lastInputTokens, config.openaiContextLimit, opts.onToolsDispatched ? [] : usedTools);
      return { response: `${forcedContent}\n\n---\n${footer}`, updatedHistory: historyOut(), cancelled: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : errMsg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      throw err;
    } finally {
      span.setAttribute("agent.iterations", iterations);
      span.setAttribute("agent.input_tokens", totalInputTokens);
      span.setAttribute("agent.output_tokens", totalOutputTokens);
      span.end();
    }
  });
}

export function formatToolArg(value: unknown): string {
  if (typeof value === "string") {
    const truncated = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `"${truncated}"`;
  }
  return JSON.stringify(value);
}

/** Returns [inputPricePerM, outputPricePerM] in USD for known model name patterns. */
function modelPricing(model: string): [number, number] | null {
  const m = model.toLowerCase();
  if (m.includes("opus")) return [15, 75];
  if (m.includes("sonnet")) return [3, 15];
  if (m.includes("haiku")) return [0.8, 4];
  return null;
}

function buildFooter(
  model: string,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalCacheReadTokens: number,
  totalCacheWriteTokens: number,
  contextTokens: number,
  contextLimit: number,
  usedTools: { name: string; input: Record<string, unknown> }[],
): string {
  const ctxPct = Math.round((contextTokens / contextLimit) * 100);
  const pricing = modelPricing(model);
  const costStr = pricing
    ? ` · $${((totalInputTokens / 1_000_000) * pricing[0] + (totalOutputTokens / 1_000_000) * pricing[1]).toFixed(4)}`
    : "";
  const cacheStr =
    totalCacheReadTokens > 0 || totalCacheWriteTokens > 0
      ? ` · cache ${totalCacheReadTokens.toLocaleString()}r ${totalCacheWriteTokens.toLocaleString()}w`
      : "";
  const statsLine = `-# ${model} · ${contextTokens.toLocaleString()} ctx (${ctxPct}%) · ${totalOutputTokens.toLocaleString()} out${cacheStr}${costStr}`;
  if (usedTools.length === 0) return statsLine;

  const toolLines = usedTools.map(({ name, input }) => {
    const args = Object.entries(input)
      .map(([k, v]) => `${k}=${formatToolArg(v)}`)
      .join(", ");
    return `-# - ${args ? `${name}(${args})` : name}`;
  });
  return `${statsLine}\n${toolLines.join("\n")}`;
}

