import type { AuthorRef, ChannelRef } from "./contracts.ts";

/**
 * Neutral inputs for one turn's system prompt. Ported 1:1 from the pre-multi-surface
 * `buildSystemPrompt(behaviorInstructions, AgentLoopOptions)` (src/agent/loop.ts) so the assembled
 * text stays byte-identical — see src/surfaces/discord/prompt.parity.test.ts. The core owns slot
 * ORDER (prompt-cache stability, C8); surfaces/modules only supply content:
 *  - `channel` / `author` come from the InboundMessage (surface-resolved).
 *  - `serverContext` / `memoryIndex` / `memoryCount` are neutral, read from the SpaceMemoryStore.
 *  - `ownerSection` (ops-triage, owner-only) and `moduleExtras` (auto-mod block) are opaque
 *    module-authored strings the surface computes; the core only positions them.
 */
export interface SystemPromptInputs {
  behavior: string;
  selfId?: string;
  selfName?: string;
  channel?: ChannelRef;
  /** Triggering user (the turn initiator). Ports the old `triggeringUser`. */
  author?: AuthorRef;
  /** Owner-only ops-triage block, already gated + built by the surface. Positioned right after
   *  the triggeringUser section, matching the old prompt. */
  ownerSection?: string;
  serverContext?: string | null;
  memoryIndex?: string[];
  memoryCount?: number;
  memoryLimit?: number;
  emojiMap?: Record<string, string>;
  threadContext?: string;
  /** Thread channel id for the "fetch older messages" note, ports `currentChannelId`. */
  threadChannelId?: string;
  /** Module-supplied sections appended last (e.g. the auto-mod enforcement block). */
  moduleExtras?: string[];
  /** Proactively-injected memory block (rendered by MemoryProvider). Opt-in: when undefined the
   *  assembled prompt is byte-identical to the pre-memory prompt (parity test relies on this). */
  memoryBlock?: string;
}

export function assembleSystemPrompt(inputs: SystemPromptInputs): string {
  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const systemParts = [
    inputs.behavior,
    `Current date: ${currentDate}. Use this only for interpreting relative time references in user messages (e.g. "yesterday", "last week"). Do NOT use it to compute or write timestamp math in your responses — always use Discord timestamp format instead.`,
  ];

  // Bot's own identity
  if (inputs.selfId) {
    const nameStr = inputs.selfName ? ` (${inputs.selfName})` : "";
    systemParts.push(`Your identity: Your Discord user ID is ${inputs.selfId}${nameStr}. When you see u:${inputs.selfId} in messages, that is yourself. Never confuse your own messages with those of other users.`);
  }

  // Current channel context
  if (inputs.channel) {
    const ch = inputs.channel;
    const privacy = ch.isPrivate ? "private (not visible to regular members)" : "public";
    const lines = [`Current channel: #${ch.name} (c:${ch.id}) — ${ch.type}, ${privacy}`];
    if (ch.categoryName) lines.push(`Category: ${ch.categoryName}`);
    if (ch.parentChannelName) lines.push(`Parent channel: #${ch.parentChannelName}`);
    if (ch.topic) lines.push(`Topic: ${ch.topic}`);
    systemParts.push(lines.join("\n"));
  }

  // Triggering user context
  if (inputs.author) {
    const u = inputs.author;
    const displayStr = u.displayName && u.displayName !== u.username ? ` (display name: ${u.displayName})` : "";
    const modStr = u.isModerator ? "yes — has moderation role" : "no";
    const roles = u.roles ?? [];
    const roleStr = roles.length > 0 ? roles.map((r) => `${r.name} (${r.id})`).join(", ") : "none";
    const lines = [
      `Request from: ${u.username}${displayStr} (u:${u.userId})`,
      `Moderator: ${modStr}`,
      `Roles: ${roleStr}`,
    ];
    systemParts.push(lines.join("\n"));

    // Owner-only ops-triage block — surface supplies it only for the owner, matching the old
    // `if (config.ownerDiscordId && u.id === config.ownerDiscordId)` branch's position.
    if (inputs.ownerSection) systemParts.push(inputs.ownerSection);
  }

  // Server context (always injected, full content)
  if (inputs.serverContext) {
    systemParts.push(`## Server Context\n${inputs.serverContext}`);
  } else if (inputs.serverContext === null) {
    systemParts.push(
      `## Server Context\nNot yet available for this space. Answer normally; your awareness of this space's structure is limited until it has been learned.`,
    );
  }

  // Proactively-injected durable memory (retrieved + rendered by MemoryProvider). Opt-in: absent
  // unless a MemoryProvider is wired, so the byte-identical parity test still holds.
  if (inputs.memoryBlock) {
    systemParts.push(inputs.memoryBlock);
  }

  // Memory index (titles only — agent fetches full content via read_memory when relevant)
  if (inputs.memoryIndex !== undefined) {
    const limit = inputs.memoryLimit ?? 25;
    const count = inputs.memoryCount ?? inputs.memoryIndex.length;
    const header = `## Agent Memory (${count}/${limit} entries)`;
    const body =
      inputs.memoryIndex.length > 0
        ? inputs.memoryIndex.map((t, i) => `${i + 1}. "${t}"`).join("\n")
        : "(empty)";
    systemParts.push(
      `${header}\nCheck this index at the start of each conversation. If any entries look relevant to the current query, call read_memory to fetch their content before proceeding. See the memory tool description for what to write and what to leave to live lookups.\n\n${body}`,
    );
  }

  if (inputs.emojiMap && Object.keys(inputs.emojiMap).length > 0) {
    const entries = Object.entries(inputs.emojiMap)
      .map(([name]) => `e:${name}`)
      .join("  ");
    systemParts.push(
      `Server emojis — use as \`e:name\` tokens (e.g. \`e:JennieLmao2\`). Available:\n${entries}\nDo not use other emojis. Do not include angle brackets or IDs — the bot expands \`e:name\` to the correct Discord syntax automatically.`,
    );
  }

  if (inputs.threadContext) {
    const channelNote = inputs.threadChannelId
      ? `\nThread channel ID: ${inputs.threadChannelId} — if the thread has more history than shown above, use fetch_channel_messages with this channel_id and before=<earliest_message_id_above> to retrieve older messages.`
      : "";
    systemParts.push(`Current thread messages (all participants including bots, excluding your own prior replies):${channelNote}\n\n${inputs.threadContext}`);
  }

  if (inputs.moduleExtras?.length) {
    systemParts.push(...inputs.moduleExtras);
  }

  return systemParts.join("\n\n---\n\n");
}
