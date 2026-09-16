// Ports src/tools/deleteUserMessages.ts. Needs BOTH hosts: candidate selection reads the
// message cache (MessageCacheHost), the actual delete calls the Discord API (DiscordHost).
import type { ToolEntry } from "../../contracts.ts";
import "../hosts.ts";

export const deleteUserMessagesEntry: ToolEntry<"discord" | "messageCache"> = {
  name: "delete_user_messages",
  definition: {
    name: "delete_user_messages",
    description:
      "Delete recent messages from a specific user in a specific channel. Scoped to the incident channel only. Bulk-deletes messages ≤14 days old; falls back to sequential deletion for older messages.",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID whose messages to delete." },
        channel_id: { type: "string", description: "The incident channel ID." },
        limit: { type: "number", description: "Maximum number of messages to delete (default: 50, max: 100)." },
      },
      required: ["user_id", "channel_id"],
    },
  },
  requiresHosts: ["discord", "messageCache"],
  async execute(input, ctx) {
    const limit = Math.min((input.limit as number | undefined) ?? 50, 100);
    const candidates = ctx.messageCache.findDeletableMessages({
      userId: input.user_id as string,
      channelId: input.channel_id as string,
      limit,
    });

    const gc = ctx.discord.getModerationConfig();
    const raw = await ctx.discord.deleteMemberMessages({
      channelId: input.channel_id as string,
      candidates: candidates.map((c) => ({ id: c.discord_id, content: c.content, createdAt: c.created_at })),
      dryRun: gc?.autoModDryRun,
    });
    if ("error" in raw) return { content: raw.error };

    const total = raw.bulkDeleted + raw.sequentialDeleted;
    const verb = raw.dryRun ? "[DRY RUN] Would delete" : "Deleted";
    const header = `${verb} ${total} message(s) (${raw.bulkDeleted} bulk, ${raw.sequentialDeleted} sequential, ${raw.errors} error(s)) of ${raw.requested} found`;
    if (raw.deleted.length === 0) return { content: header };
    return { content: `${header}\n${raw.deleted.map((m) => `  msg:${m.id}: "${m.content}"`).join("\n")}` };
  },
};
