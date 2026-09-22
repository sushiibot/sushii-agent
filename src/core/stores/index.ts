export { SqliteConversationStore } from "./conversationStore.ts";
export { DiscordSpaceMemoryStore, MEMORY_LIMIT } from "./memoryStore.ts";

/** Reserved memory title holding a space's always-injected "core profile" (Tier A memory): a small,
 *  stable, curated block about the user/space, kept in the cached system prompt and self-edited via
 *  the update_profile tool. Hidden from the normal memory index. Per-space today (DM = the owner). */
export const CORE_PROFILE_TITLE = "__core_profile__";
