import { generateText, type ModelMessage } from "ai";
import { openaiProvider } from "./client.ts";
import { config } from "../config.ts";
import { getLogger } from "../logger.ts";
import type { MemoryProvider, TurnEndContext } from "../core/contracts.ts";

const logger = getLogger("agent/memoryDeriver");

// The write-side of first-class memory: instead of relying on the agent to call the memory tool, a
// cheap model extracts durable facts from each finished turn and persists them. Curation policy lives
// HERE (what to save / never save), and the store's dedup + importance are the junk backstop.
const EXTRACT_SYSTEM =
  "You extract durable, non-authoritative facts worth remembering long-term about the user or this space, " +
  "from one conversation exchange.\n\n" +
  "SAVE only: stable preferences, decisions, standing context, relationships, ongoing goals — things still " +
  "useful weeks later.\n" +
  "NEVER save: dated or authoritative data that lives in other systems (moderation actions, role/permission " +
  "state, ban/timeout status), secrets or credentials, transient chit-chat, one-off task mechanics, or anything " +
  "the user asked to keep private or to forget.\n\n" +
  'Respond with ONLY a JSON object: {"facts":[{"content":"<concise self-contained fact>","importance":<0.0-1.0>}]}. ' +
  'Use {"facts":[]} when nothing durable is present. Be conservative — no fact is better than a junk fact.';

const MAX_FACTS_PER_TURN = 5;
const MIN_USER_CHARS = 12;

interface DerivedFact {
  content: string;
  importance?: number;
}

/** Builds an `onTurnEnd` hook that derives + persists durable memory. Fire-and-forget: it never
 *  blocks the reply and swallows its own errors (memory is best-effort). Returns a no-op when the
 *  deriver is disabled by config. */
export function createMemoryDeriver(memoryProvider: MemoryProvider): (ctx: TurnEndContext) => void {
  if (!config.memoryDeriverEnabled) return () => {};
  const model = openaiProvider(config.compactionModel || config.openaiModel);

  async function derive(ctx: TurnEndContext): Promise<void> {
    const userText = lastUserText(ctx.history);
    if (userText.length < MIN_USER_CHARS) return; // skip trivial turns
    const replyText = ctx.reply.segments
      .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
      .map((s) => s.text)
      .join("\n")
      .trim();

    const res = await generateText({
      model,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: `User: ${userText}\n\nAssistant: ${replyText}` },
      ],
      maxOutputTokens: 512,
    });

    const facts = parseFacts(res.text);
    const scope = { spaceId: ctx.conversation.spaceId, userId: ctx.authorId, isPrivate: ctx.isPrivate };
    for (const f of facts) {
      await memoryProvider.remember({ scope, text: f.content, importance: f.importance });
    }
    if (facts.length > 0) {
      logger.debug({ spaceId: ctx.conversation.spaceId, count: facts.length }, "derived durable memory from turn");
    }
  }

  return (ctx) => {
    void derive(ctx).catch((err) => logger.debug({ err }, "memory deriver failed"));
  };
}

export function lastUserText(history: readonly ModelMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && typeof m.content === "string") return m.content.trim();
  }
  return "";
}

export function parseFacts(text: string): DerivedFact[] {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const obj = JSON.parse(cleaned) as { facts?: unknown };
    if (!Array.isArray(obj.facts)) return [];
    return obj.facts
      .filter((f): f is { content: string; importance?: unknown } => !!f && typeof (f as { content?: unknown }).content === "string" && (f as { content: string }).content.trim().length > 0)
      .map((f) => ({ content: f.content.trim(), importance: typeof f.importance === "number" ? f.importance : undefined }))
      .slice(0, MAX_FACTS_PER_TURN);
  } catch {
    return [];
  }
}
