// Ports the DiscordToolHost-backed tools from src/tools/*.ts + moderation/executor.ts's
// formatToolResult cases. Concrete DiscordHost implementation is out of scope here (BRIEF: "the
// concrete impl is built by the Discord surface, not here").
import type { ToolEntry } from "../../contracts.ts";
import "../hosts.ts";
import "../pendingSink.ts";
import { formatMessageRows, collectKnownUsersFromRows } from "../format.ts";

export const fetchChannelMessagesEntry: ToolEntry<"discord"> = {
  name: "fetch_channel_messages",
  definition: {
    name: "fetch_channel_messages",
    description:
      "Fetch messages directly from the Discord API by ID or ID range — use when a message is not in the local cache. Use message_id alone for a single message. Use around only when you need surrounding context, and keep limit small (5–10).",
    parameters: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Discord channel ID (snowflake)." },
        message_id: { type: "string", description: "Fetch exactly this one message by ID." },
        before: { type: "string", description: "Fetch messages sent before this message ID (exclusive)." },
        after: { type: "string", description: "Fetch messages sent after this message ID (exclusive)." },
        around: { type: "string", description: "Fetch messages around this message ID." },
        limit: { type: "number", description: "Number of messages to return for range fetches (1–100, default 10)." },
      },
      required: ["channel_id"],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const raw = await ctx.discord.fetchChannelMessages({
      channelId: input.channel_id as string,
      messageId: input.message_id as string | undefined,
      before: input.before as string | undefined,
      after: input.after as string | undefined,
      around: input.around as string | undefined,
      limit: input.limit as number | undefined,
    });
    if ("error" in raw) return { content: raw.error };
    collectKnownUsersFromRows(raw, ctx.knownUsers);
    return { content: formatMessageRows(raw, `c:${input.channel_id as string}`) };
  },
};

export const searchGuildMessagesEntry: ToolEntry<"discord"> = {
  name: "search_guild_messages",
  definition: {
    name: "search_guild_messages",
    description:
      "Search all guild message history via the Discord API — use when the local cache (~30 days) doesn't have what you need. Slower, limited to 25 results per call; use offset to paginate. At least one of content, author_id, or channel_id is required.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Filter by message content (substring match, max 1024 chars)." },
        author_id: { type: "string", description: "Filter to messages from this Discord user ID." },
        channel_id: { type: "string", description: "Filter to messages in this channel ID." },
        has: { type: "string", enum: ["image", "video", "file", "embed", "link", "poll"], description: "Filter to messages containing this attachment/embed type." },
        limit: { type: "number", description: "Results per page (1–25, default 25)." },
        offset: { type: "number", description: "Pagination offset (0–9975)." },
        sort_by: { type: "string", enum: ["timestamp", "relevance"], description: "Sort by timestamp (default) or relevance." },
        sort_order: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default: desc)." },
      },
      required: [],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const raw = await ctx.discord.searchGuildMessages({
      content: input.content as string | undefined,
      authorId: input.author_id as string | undefined,
      channelId: input.channel_id as string | undefined,
      has: input.has as string | undefined,
      limit: input.limit as number | undefined,
      offset: input.offset as number | undefined,
      sortBy: input.sort_by as "timestamp" | "relevance" | undefined,
      sortOrder: input.sort_order as "asc" | "desc" | undefined,
    });
    if ("error" in raw) return { content: raw.error };
    if (raw.messages.length === 0) {
      return { content: "(no results for the given filters — nothing matches these filters; only different filters will change this, not a different limit or offset)" };
    }
    collectKnownUsersFromRows(raw.messages, ctx.knownUsers);
    return { content: `total: ${raw.totalResults}, showing ${raw.messages.length}\n${formatMessageRows(raw.messages, "the given filters")}` };
  },
};

export const getChannelInfoEntry: ToolEntry<"discord"> = {
  name: "get_channel_info",
  definition: {
    name: "get_channel_info",
    description:
      "Get channel information. Without channel_id: lists all channels organized by category. With channel_id: get details about that specific channel.",
    parameters: {
      type: "object",
      properties: { channel_id: { type: "string", description: "Discord channel ID (snowflake). Omit to list all channels." } },
      required: [],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    if (input.channel_id) {
      const raw = await ctx.discord.getChannelInfo(input.channel_id as string);
      if ("error" in raw) return { content: raw.error };
      const lines: string[] = [`c:${raw.id} #${raw.name}`, `type: ${raw.type}`, `privacy: ${raw.isPrivate ? "private (not visible to @everyone)" : "public"}`];
      if (raw.categoryName) lines.push(`category: ${raw.categoryName}`);
      if (raw.parentChannelName) lines.push(`parent channel: #${raw.parentChannelName} (c:${raw.parentChannelId})`);
      if (raw.topic) lines.push(`topic: ${raw.topic}`);
      return { content: lines.join("\n") };
    }

    const raw = await ctx.discord.listGuildChannels();
    if ("error" in raw) return { content: raw.error };
    if (raw.length === 0) return { content: "(no results)" };

    const byCategory = new Map<string, { name: string; channels: typeof raw }>();
    const noCat: typeof raw = [];
    for (const ch of raw) {
      if (ch.categoryName && ch.categoryId) {
        if (!byCategory.has(ch.categoryId)) byCategory.set(ch.categoryId, { name: ch.categoryName, channels: [] });
        byCategory.get(ch.categoryId)!.channels.push(ch);
      } else {
        noCat.push(ch);
      }
    }

    const renderGroup = (channels: typeof raw) =>
      channels.map((ch) => {
        let line = `  c:${ch.id} #${ch.name} (${ch.type}, ${ch.isPrivate ? "private" : "public"})`;
        if (ch.topic) line += ` — ${ch.topic}`;
        return line;
      });

    const lines: string[] = [];
    for (const { name, channels } of byCategory.values()) {
      lines.push(`[${name}]`, ...renderGroup(channels));
    }
    if (noCat.length > 0) lines.push("[No category]", ...renderGroup(noCat));
    return { content: lines.join("\n") };
  },
};

export const listGuildRolesEntry: ToolEntry<"discord"> = {
  name: "list_guild_roles",
  definition: {
    name: "list_guild_roles",
    description: "List all roles in the server with their permissions, sorted by hierarchy.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  requiresHosts: ["discord"],
  async execute(_input, ctx) {
    const raw = await ctx.discord.listGuildRoles();
    if ("error" in raw) return { content: raw.error };
    if (raw.length === 0) return { content: "(no results)" };
    return {
      content: raw
        .map((r) => {
          const flags: string[] = [];
          if (r.isAdmin) flags.push("admin");
          else if (r.isModerator) flags.push("moderator permissions");
          const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
          const colorStr = r.color ? ` ${r.color}` : "";
          return `${r.name} (${r.id})${colorStr}${flagStr}`;
        })
        .join("\n"),
    };
  },
};

export const getGuildInfoEntry: ToolEntry<"discord"> = {
  name: "get_guild_info",
  definition: {
    name: "get_guild_info",
    description: "Get server-level information — name, member count, owner, creation date, verification level, boost tier, and enabled features.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  requiresHosts: ["discord"],
  async execute(_input, ctx) {
    const raw = await ctx.discord.getGuildInfo();
    if ("error" in raw) return { content: raw.error };
    const lines: string[] = [
      `${raw.name} (${raw.id})`,
      `owner: u:${raw.ownerId}`,
      `created: t:${Math.floor(raw.createdAt / 1000)}:R`,
      `members: ${raw.memberCount.toLocaleString()}`,
      `verification: ${raw.verificationLevel}`,
      `boost tier: ${raw.boostTier} (${raw.boostCount} boosts)`,
      `locale: ${raw.preferredLocale}`,
    ];
    if (raw.description) lines.push(`description: ${raw.description}`);
    if (raw.features.length > 0) lines.push(`features: ${raw.features.join(", ")}`);
    return { content: lines.join("\n") };
  },
};

export const getCurrentMemberInfoEntry: ToolEntry<"discord"> = {
  name: "get_current_member_info",
  definition: {
    name: "get_current_member_info",
    description: "Get live Discord information about a member — current roles, join date, and whether they are still in the server.",
    parameters: {
      type: "object",
      properties: { user_id: { type: "string", description: "Discord user ID (snowflake)" } },
      required: ["user_id"],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const r = await ctx.discord.getCurrentMemberInfo(input.user_id as string);
    if (!r.isStillInServer) return { content: `u:${r.userId} — not in server` };
    const lines: string[] = [`user: ${r.username} (u:${r.userId})`];
    if (r.displayName && r.displayName !== r.username) lines.push(`display name: ${r.displayName}`);
    if (r.joinedAt) lines.push(`joined: t:${Math.floor(r.joinedAt / 1000)}:R`);
    lines.push("in server: yes");
    lines.push(r.roles && r.roles.length > 0 ? `roles: ${r.roles.map((role) => `${role.name} (${role.id})`).join(", ")}` : "roles: none");
    if (r.avatarUrl) lines.push(`avatarUrl: ${r.avatarUrl}`);
    return { content: lines.join("\n") };
  },
};

export const searchAuditLogEntry: ToolEntry<"discord"> = {
  name: "search_audit_log",
  definition: {
    name: "search_audit_log",
    description: "Search the server's audit log for moderation actions. Always provide at least one filter — unfiltered results are dominated by noise.",
    parameters: {
      type: "object",
      properties: {
        action_type: {
          type: "string",
          enum: ["ban", "unban", "kick", "member_update", "role_update", "message_delete", "message_bulk_delete", "automod_block"],
          description: "Filter by action type.",
        },
        executor_id: { type: "string", description: "Filter to actions performed by this Discord user ID." },
        target_id: { type: "string", description: "Filter to actions targeting this Discord user ID." },
        limit: { type: "number", description: "Maximum number of entries to return (default: 25, max: 100)." },
      },
      required: [],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const entries = await ctx.discord.searchAuditLog({
      actionType: input.action_type as string | undefined,
      executorId: input.executor_id as string | undefined,
      targetId: input.target_id as string | undefined,
      limit: input.limit as number | undefined,
    });
    if (entries.length === 0) return { content: "(no results for the given filters — nothing matches these filters; only different filters will change this, not a different limit)" };
    for (const e of entries) {
      if (e.executorId) ctx.knownUsers?.add(e.executorId, { username: e.executorUsername, displayName: null });
    }
    return {
      content: entries
        .map((e) => {
          const seconds = Math.floor(e.createdAt / 1000);
          const executor = e.executorId ? `u:${e.executorId}` : "unknown";
          const target = e.targetId ? `u:${e.targetId}` : "unknown";
          let line = `t:${seconds}:R ${e.action} — ${executor} → ${target}`;
          if (e.reason) line += ` | reason: "${e.reason}"`;
          if (e.changes.length > 0) {
            line += `\n  changes: ${e.changes.map((c) => `${c.key}: ${JSON.stringify(c.old)}→${JSON.stringify(c.new)}`).join(", ")}`;
          }
          return line;
        })
        .join("\n"),
    };
  },
};

export const listAutomodRulesEntry: ToolEntry<"discord"> = {
  name: "list_automod_rules",
  definition: {
    name: "list_automod_rules",
    description: "List all auto-moderation rules for this server — names, IDs, trigger types, keyword/regex counts, enabled status, and actions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  requiresHosts: ["discord"],
  async execute(_input, ctx) {
    const raw = await ctx.discord.listAutomodRules();
    if ("error" in raw) return { content: raw.error };
    if (raw.length === 0) return { content: "(no automod rules configured)" };
    return {
      content: raw
        .map((rule) => {
          const status = rule.enabled ? "enabled" : "disabled";
          const lines: string[] = [`rule: "${rule.name}" (id:${rule.id}) [${rule.triggerType}] ${status}`];
          if (rule.keywordFilter.length > 0) {
            const preview = rule.keywordFilter.slice(0, 20).join(", ");
            const more = rule.keywordFilter.length > 20 ? ` [+${rule.keywordFilter.length - 20} more]` : "";
            lines.push(`  keywords (${rule.keywordFilter.length}): ${preview}${more}`);
          }
          if (rule.regexPatterns.length > 0) lines.push(`  regex: ${rule.regexPatterns.length} pattern(s)`);
          if (rule.allowList.length > 0) lines.push(`  allow list: ${rule.allowList.length} item(s)`);
          const actionStrs = rule.actions.map((a) => {
            if (a.type === "send_alert_message" && a.channelId) return `alert → c:${a.channelId}`;
            if (a.type === "timeout" && a.durationSeconds) return `timeout ${a.durationSeconds}s`;
            return a.type;
          });
          if (actionStrs.length > 0) lines.push(`  actions: ${actionStrs.join(", ")}`);
          if (rule.exemptRoleIds.length > 0) lines.push(`  exempt roles: ${rule.exemptRoleIds.map((id) => `r:${id}`).join(", ")}`);
          if (rule.exemptChannelIds.length > 0) lines.push(`  exempt channels: ${rule.exemptChannelIds.map((id) => `c:${id}`).join(", ")}`);
          return lines.join("\n");
        })
        .join("\n\n"),
    };
  },
};

export const addAutomodKeywordEntry: ToolEntry<"discord"> = {
  name: "add_automod_keyword",
  definition: {
    name: "add_automod_keyword",
    description:
      "Add a single keyword to an existing automod rule's keyword_filter. This triggers an approval gate — do NOT call ask_question first, the moderator is prompted automatically. Only works for KEYWORD and MEMBER_PROFILE rules.\n\nWildcard syntax: *word* = anywhere, word* = prefix, *word = suffix, word = whole-word. Max 60 chars.",
    parameters: {
      type: "object",
      properties: {
        rule_id: { type: "string", description: "The automod rule ID (snowflake). Get this from list_automod_rules." },
        keyword: { type: "string", description: "The keyword string to add. Max 60 characters." },
      },
      required: ["rule_id", "keyword"],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    if (!ctx.owner) return { content: "Cannot request this change right now — the original requester's identity was lost mid-conversation." };
    const raw = await ctx.discord.addAutomodKeyword({ ruleId: input.rule_id as string, keyword: input.keyword as string });
    if ("error" in raw) return { content: raw.error };
    ctx.pending?.push({
      kind: "approval",
      payload: {
        action: "automod-keyword-add",
        summary: `Add keyword "${raw.keyword}" to rule "${raw.ruleName}"`,
        authorizedResponder: ctx.owner,
        platform: { surface: "discord", ruleId: raw.ruleId, ruleName: raw.ruleName, keyword: raw.keyword },
      },
    });
    return { content: `Keyword addition queued for moderator approval. The moderator will see a confirmation prompt showing the change to rule "${raw.ruleName}".` };
  },
};

export const deleteAutomodKeywordEntry: ToolEntry<"discord"> = {
  name: "delete_automod_keyword",
  definition: {
    name: "delete_automod_keyword",
    description:
      "Remove a single keyword from an existing automod rule's keyword_filter. This triggers an approval gate — do NOT call ask_question first. Returns an error if the keyword is not found.",
    parameters: {
      type: "object",
      properties: {
        rule_id: { type: "string", description: "The automod rule ID (snowflake). Get this from list_automod_rules." },
        keyword: { type: "string", description: "The keyword string to remove. Must match an existing entry." },
      },
      required: ["rule_id", "keyword"],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    if (!ctx.owner) return { content: "Cannot request this change right now — the original requester's identity was lost mid-conversation." };
    const raw = await ctx.discord.deleteAutomodKeyword({ ruleId: input.rule_id as string, keyword: input.keyword as string });
    if ("error" in raw) return { content: raw.error };
    ctx.pending?.push({
      kind: "approval",
      payload: {
        action: "automod-keyword-delete",
        summary: `Remove keyword "${raw.keyword}" from rule "${raw.ruleName}"`,
        authorizedResponder: ctx.owner,
        platform: { surface: "discord", ruleId: raw.ruleId, ruleName: raw.ruleName, keyword: raw.keyword },
      },
    });
    return { content: `Keyword deletion queued for moderator approval. The moderator will see a confirmation prompt showing the removal from rule "${raw.ruleName}".` };
  },
};

export const timeoutMemberEntry: ToolEntry<"discord"> = {
  name: "timeout_member",
  definition: {
    name: "timeout_member",
    description:
      "Apply a timeout (communication disable) to a member. Do NOT call this for members with mod-immune roles. Default duration: 3600000 ms (1 hour). Maximum: 2419200000 ms (28 days).",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID of the member to timeout." },
        duration_ms: { type: "number", description: "Timeout duration in milliseconds (default: 3600000, max: 2419200000)." },
        reason: { type: "string", description: "Category label shown to the user, 1-2 words (e.g. \"Harassment\", \"Spam\"). Never include evidence or reasoning." },
      },
      required: ["user_id", "duration_ms"],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const gc = ctx.discord.getModerationConfig();
    if (!gc) return { content: "Guild not configured" };
    const raw = await ctx.discord.timeoutMember({
      userId: input.user_id as string,
      durationMs: input.duration_ms as number,
      reason: input.reason as string | undefined,
      modImmuneRoleIds: gc.modImmuneRoleIds,
      dryRun: gc.autoModDryRun,
    });
    if ("error" in raw) return { content: raw.error };
    const mins = Math.round(raw.durationMs / 60000);
    const expires = Math.floor(raw.expiresAt / 1000);
    const verb = raw.dryRun ? "[DRY RUN] Would apply timeout" : "Timeout applied";
    return { content: `${verb}: u:${raw.userId} muted for ${mins} minute(s) (expires t:${expires}:R)` };
  },
};

export const sendAlertMessageEntry: ToolEntry<"discord"> = {
  name: "send_alert_message",
  definition: {
    name: "send_alert_message",
    description:
      "Post a summary to the configured mod alerts channel with a mod-role ping. Call this at the end of every auto-mod run — whether action was taken or not. This is a skim-read for a mod on their phone, not a report.",
    parameters: {
      type: "object",
      properties: {
        findings: { type: "string", description: "A bullet list, max 4-5 bullets. One short clause per bullet, grouping repeated patterns." },
        action: {
          type: "string",
          description: "Labeled lines: **Action:**, **Why:**, **Background:** (optional), **Recommendation:** (only if follow-up needed).",
        },
      },
      required: ["findings", "action"],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const gc = ctx.discord.getModerationConfig();
    if (!gc?.alertsChannelId || !gc.modRoleId) return { content: "alertsChannelId or modRoleId not configured for this guild" };
    // U0's AutoModTrigger (contracts.ts §2) doesn't carry anchorMessageId/incidentChannelId/
    // triggerMessageId, so the alert can't yet re-link to the triggering incident message here.
    const raw = await ctx.discord.sendAlertMessage({
      findings: input.findings as string,
      action: input.action as string,
      alertsChannelId: gc.alertsChannelId,
      modRoleId: gc.modRoleId,
      dryRun: gc.autoModDryRun,
    });
    if ("error" in raw) return { content: raw.error };
    return { content: `Alert sent (msg:${raw.messageId})` };
  },
};

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

function isDiscordCdnUrl(url: string): boolean {
  try {
    return DISCORD_CDN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The signature query params change on every refresh, but the path identifies the attachment —
 *  dedup keys on this so a stale URL and its freshly-fetched twin collapse into one candidate. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function isUsableImageUrl(url: string): Promise<boolean> {
  if (!isDiscordCdnUrl(url)) return true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export const inspectImageEntry: ToolEntry<"discord"> = {
  name: "inspect_image",
  definition: {
    name: "inspect_image",
    description:
      "Queue one or more images so they appear in your next message for visual analysis. Discord's attachment URLs are signed and expire, so pass channel_id + message_id via `messages` for anything not fetched this same turn — that re-fetches live.",
    parameters: {
      type: "object",
      properties: {
        image_urls: { type: "array", items: { type: "string" }, description: "Direct URLs with no backing message. Must be Discord CDN URLs." },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: { channel_id: { type: "string" }, message_id: { type: "string" } },
            required: ["channel_id", "message_id"],
          },
          description: "Messages to re-fetch live and inspect all image attachments from.",
        },
      },
      anyOf: [{ required: ["image_urls"] }, { required: ["messages"] }],
    },
  },
  requiresHosts: ["discord"],
  async execute(input, ctx) {
    const imageUrls = input.image_urls as string[] | undefined;
    const messages = input.messages as { channel_id: string; message_id: string }[] | undefined;
    if ((!imageUrls || imageUrls.length === 0) && (!messages || messages.length === 0)) {
      return { content: "inspect_image requires image_urls, messages, or both." };
    }

    const candidates: { url: string; source?: { channelId: string; messageId: string } }[] = [];
    if (imageUrls && imageUrls.length > 0) {
      const invalid = imageUrls.filter((u) => !isDiscordCdnUrl(u));
      if (invalid.length > 0) return { content: `image_urls must be discordapp.com or discordapp.net CDN URLs. Rejected: ${invalid.join(", ")}` };
      candidates.push(...imageUrls.map((url) => ({ url })));
    }

    if (messages && messages.length > 0) {
      for (const m of messages) {
        const source = { channelId: m.channel_id, messageId: m.message_id };
        const urls = await ctx.discord.fetchMessageImageUrls(source);
        if ("error" in urls) return { content: urls.error };
        candidates.push(...urls.map((url) => ({ url, source })));
      }
    }

    const unique = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      const key = urlPath(c.url);
      const existing = unique.get(key);
      if (!existing || (!existing.source && c.source)) unique.set(key, c);
    }

    const checked = await Promise.all([...unique.values()].map(async (c) => ({ ...c, ok: await isUsableImageUrl(c.url) })));
    const live = checked.filter((c) => c.ok).map((c) => c.url);
    const dead = checked.filter((c) => !c.ok).map((c) => c.url);

    const lines: string[] = [];
    if (live.length > 0 && ctx.images) {
      ctx.images.push(live);
      lines.push(`${live.length} image(s) attached directly below this tool result — read them from there. Do not call inspect_image again for them.`);
    } else if (live.length > 0) {
      lines.push("inspect_image is unavailable in this context.");
    }
    if (dead.length > 0) {
      lines.push(
        `${dead.length} image URL(s) could not be loaded — the signature is expired or the URL is mistyped. Do not retype or guess these URLs. Call inspect_image again with the channel_id + message_id they came from via \`messages\`:\n${dead.map((u) => `- ${u}`).join("\n")}`,
      );
    }
    if (lines.length === 0) lines.push("No image attachments found on that message.");
    return { content: lines.join("\n\n") };
  },
};

export const DISCORD_TOOL_ENTRIES: ToolEntry<"discord">[] = [
  fetchChannelMessagesEntry,
  searchGuildMessagesEntry,
  getChannelInfoEntry,
  listGuildRolesEntry,
  getGuildInfoEntry,
  getCurrentMemberInfoEntry,
  searchAuditLogEntry,
  listAutomodRulesEntry,
  addAutomodKeywordEntry,
  deleteAutomodKeywordEntry,
  timeoutMemberEntry,
  sendAlertMessageEntry,
  inspectImageEntry,
];
