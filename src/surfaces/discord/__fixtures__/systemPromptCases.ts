import type { SystemPromptInputs } from "../../../core/systemPrompt.ts";

// Neutral per-turn prompt inputs, one per production shape. Opaque module-authored content
// (behavior, ops-triage, auto-mod blocks) uses short SENTINELs — assembleSystemPrompt only
// concatenates those verbatim, so their real text is tested at its source, not here. This keeps
// the golden small and lets it survive deletion of the old builder (prompt.oracle.test.ts, temp).
export const BEHAVIOR_SENTINEL = "BEHAVIOR_SENTINEL";
export const OWNER_SECTION_SENTINEL = "OWNER_SECTION_SENTINEL";
export const MODULE_EXTRA_SENTINEL = "MODULE_EXTRA_SENTINEL";

/** Cases with a byte-for-byte golden (see systemPrompt.golden.json). No `ownerSection`. */
export const PROMPT_CASES: Record<string, SystemPromptInputs> = {
  // Standard mention/reply turn: identity + channel + triggering user + server context + memory
  // + emoji + thread context, mirroring bot.ts's buildLoopOptions.
  mention_full: {
    behavior: BEHAVIOR_SENTINEL,
    selfId: "BOT",
    selfName: "sushii",
    channel: { id: "C1", name: "help", type: "thread (public)", isPrivate: false, parentChannelName: "general", categoryName: "Support", topic: "be nice" },
    author: { surface: "discord", userId: "U1", username: "alice", displayName: "Alice", isModerator: true, roles: [{ id: "R1", name: "Mod" }, { id: "R2", name: "Helper" }] },
    serverContext: "Rules in c:123.",
    memoryIndex: ["note a", "note b"],
    memoryCount: 2,
    memoryLimit: 100,
    emojiMap: { JennieLmao2: "<:JennieLmao2:1>", Kek: "<:Kek:2>" },
    threadContext: "t:1 u:U9: hi",
    threadChannelId: "C1",
  },
  // First-run guild: serverContext === null (scan-suggest section), empty memory, no emoji/thread.
  mention_null_ctx: {
    behavior: BEHAVIOR_SENTINEL,
    selfId: "BOT",
    selfName: "sushii",
    channel: { id: "C2", name: "general", type: "text", isPrivate: false },
    author: { surface: "discord", userId: "U2", username: "bob", displayName: null, isModerator: false, roles: [] },
    serverContext: null,
    memoryIndex: [],
    memoryCount: 0,
    memoryLimit: 100,
  },
  // Autonomous auto-mod driver: no triggeringUser/channel, module block appended last.
  automod: {
    behavior: BEHAVIOR_SENTINEL,
    selfId: "BOT",
    selfName: "sushii",
    serverContext: "ctx",
    memoryIndex: ["m"],
    memoryCount: 1,
    memoryLimit: 100,
    emojiMap: { Kek: "<:Kek:2>" },
    threadContext: "tc",
    threadChannelId: "T1",
    moduleExtras: [MODULE_EXTRA_SENTINEL],
  },
  // Headless / minimal: behavior + date only.
  minimal: {
    behavior: BEHAVIOR_SENTINEL,
  },
};

/** Owner turn — tested structurally (position of ownerSection), not against a byte golden, since
 *  the old builder gated it on live config that the golden can't reproduce deterministically. */
export const OWNER_CASE: SystemPromptInputs = {
  ...PROMPT_CASES.mention_full,
  author: { ...PROMPT_CASES.mention_full.author!, userId: "OWNER" },
  ownerSection: OWNER_SECTION_SENTINEL,
};

/** Replaces the volatile `Current date: YYYY-MM-DD.` line so goldens are date-agnostic. */
export function normalizeDate(text: string): string {
  return text.replace(/Current date: \d{4}-\d{2}-\d{2}\./, "Current date: <DATE>.");
}
