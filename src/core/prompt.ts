import type { AuthorRef, PromptGuidance, PromptSlot, TurnResumption } from "./contracts.ts";

/** Fixed slot order — this is what keeps the system prompt byte-stable for the ephemeral
 *  provider cache across turns. Surfaces only fill slot content; they never reorder it. */
const PROMPT_SLOT_ORDER: readonly PromptSlot[] = [
  "behavior",
  "identity",
  "channel",
  "triggeringUser",
  "serverContext",
  "memoryIndex",
  "emoji",
  "threadContext",
  "moduleExtras",
];

export function buildSystemPrompt(behavior: string, guidance: PromptGuidance): string {
  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const dateNote = `Current date: ${currentDate}. Use this only for interpreting relative time references in user messages (e.g. "yesterday", "last week"). Do NOT use it to compute or write timestamp math in your responses — always use Discord timestamp format instead.`;

  const sections: Partial<Record<PromptSlot, string>> = {
    ...guidance.sections,
    behavior: `${behavior}\n\n${dateNote}`,
  };

  return PROMPT_SLOT_ORDER.map((slot) => sections[slot])
    .filter((s): s is string => !!s)
    .join("\n\n---\n\n");
}

/** Ports the old `[Internal: user identity mappings ...]` note the model is told never to surface. */
export function buildUserNote(novel: AuthorRef[]): string {
  const lines = novel.map((author) => {
    const parts = [author.username, author.displayName].filter(Boolean);
    return `• u:${author.userId} = ${parts.join(" / ") || "(unknown)"}`;
  });
  return `[Internal: user identity mappings for resolving names — do not quote or surface this to the user]\n${lines.join("\n")}`;
}

/** The surface owns the full user-turn framing (the `[Message from ...]` wrapper, reply context, and
 *  the auto-mod query shape) and passes it as `InboundMessage.text`; the core relays it verbatim.
 *  This resumption framing is the one exception — a button click carries only a neutral choice/
 *  decision, so the core frames it. Ports the old `[Selected: "${choice}"]` (bot.ts). */
export function formatResumptionAsUserTurn(resumption: TurnResumption): string {
  if (resumption.kind === "question-answer") return `[Selected: "${resumption.choice}"]`;
  // approval resume: the surface supplies the exact post-apply system message when the approval
  // path is wired (U4-cutover phase 2b); this neutral fallback is unused until then.
  return resumption.systemMessage ?? `[System: Moderator ${resumption.decision === "approved" ? "approved" : "rejected"} the request.]`;
}
