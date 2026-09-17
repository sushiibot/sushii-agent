import type { Message, ThreadChannel } from "discord.js";
import type { ModelMessage, TextPart } from "ai";
import { generateText } from "ai";
import type { ConversationRef, HookBus, InboundMessage, TurnEndContext } from "../../core/contracts.ts";
import { conversationKey } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { ToolProgressTracker } from "./delivery.ts";

const logger = getLogger("surfaces/discord/hooks");

const DEFAULT_THREAD_NAME = "sushii-agent investigation";
const TYPING_INTERVAL_MS = 8000;

// onQueued/onConsumed only carry the neutral InboundMessage (contracts.ts §2), which has no
// Discord message reference for the ⏳/✅ reactions. Whoever builds each InboundMessage (the
// gateway wiring, U4-cutover) must call attachDiscordMessage(inbound, message) before handing it
// to AgentCore — keyed on object identity since the same instance flows through both hooks.
const inboundMessages = new WeakMap<InboundMessage, Message>();

export function attachDiscordMessage(inbound: InboundMessage, message: Message): void {
  inboundMessages.set(inbound, message);
}

export interface RegisterDiscordHooksDeps {
  resolveThread(conversation: ConversationRef): Promise<ThreadChannel | null>;
  getToolTracker(conversation: ConversationRef): ToolProgressTracker | undefined;
  /** Provider call for the thread-rename summarizer — kept injectable so hooks.ts has no direct
   *  dependency on a specific AI SDK provider/config wiring. */
  generateTitle?(history: ModelMessage[]): Promise<string | null>;
}

const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

function stopTyping(key: string): void {
  const interval = typingIntervals.get(key);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(key);
  }
}

function extractText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p): p is TextPart => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join(" ")
      .trim();
  }
  return "";
}

async function defaultGenerateTitle(history: ModelMessage[]): Promise<string | null> {
  const { openaiProvider } = await import("../../agent/client.ts");
  const { config } = await import("../../config.ts");

  const textHistory = history
    .filter((m): m is ModelMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .flatMap((m) => {
      const text = extractText(m.content);
      return text ? [{ role: m.role, content: text.slice(0, 500) }] : [];
    })
    .slice(-6);

  const result = await generateText({
    model: openaiProvider(config.openaiModel),
    messages: [
      ...textHistory,
      { role: "user", content: "Write a thread title of 5 words or fewer summarizing this conversation topic. Do not include any person's name or username. Return only the title, no quotes or punctuation." },
    ],
    maxOutputTokens: 60,
  });
  return result.text.trim() || null;
}

/** Wires the observational (Tier 3) hooks (contracts.ts §6) for the Discord surface: ⏳/✅
 *  reactions on queue/consume, typing indicators for the turn's duration, live tool progress via
 *  ToolProgressTracker, and the thread-rename heuristic on turn end. */
export function registerDiscordHooks(bus: HookBus, deps: RegisterDiscordHooksDeps): void {
  bus.on("onQueued", ({ inbound }) => {
    const msg = inboundMessages.get(inbound);
    msg?.react("⏳").catch(() => {});
  });

  bus.on("onConsumed", ({ inbound }) => {
    const msg = inboundMessages.get(inbound);
    if (!msg) return;
    msg.reactions.cache.get("⏳")?.users.remove(msg.client.user.id).catch(() => {});
    msg.react("✅").catch(() => {});
  });

  bus.on("onTurnStart", ({ conversation }) => {
    const key = conversationKey(conversation);
    void deps.resolveThread(conversation).then((thread) => {
      if (!thread) return;
      thread.sendTyping().catch(() => {});
      stopTyping(key);
      typingIntervals.set(key, setInterval(() => { thread.sendTyping().catch(() => {}); }, TYPING_INTERVAL_MS));
    });
  });

  const stopTypingFor = (conversation: ConversationRef) => stopTyping(conversationKey(conversation));
  bus.on("onTurnEnd", (ctx) => stopTypingFor(ctx.conversation));
  bus.on("onCancelled", ({ conversation }) => stopTypingFor(conversation));
  bus.on("onPaused", ({ conversation }) => stopTypingFor(conversation));

  bus.on("onToolsDispatched", ({ conversation, tools }) => {
    deps.getToolTracker(conversation)?.add(tools);
  });

  bus.on("onTurnEnd", (ctx: TurnEndContext) => {
    if (ctx.reply.cancelled) return;
    const toolUseCount = ctx.toolUseCount;
    const userTurnCount = ctx.userTurnCount;
    const enoughContext = toolUseCount >= 3 || userTurnCount >= 2;
    if (toolUseCount === 0 || !enoughContext) return;

    void deps.resolveThread(ctx.conversation).then(async (thread) => {
      if (!thread) return;
      const isDefaultName = thread.name === DEFAULT_THREAD_NAME;
      if (!isDefaultName) return;
      try {
        const title = await (deps.generateTitle ?? defaultGenerateTitle)([...ctx.history]);
        if (title) await thread.setName(title.slice(0, 100));
      } catch (err) {
        logger.error({ err }, "failed to rename thread");
      }
    });
  });
}
