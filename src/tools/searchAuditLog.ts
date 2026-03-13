import type { Client } from "discord.js";
import { AuditLogEvent } from "discord.js";

const ACTION_TYPE_MAP: Record<string, AuditLogEvent> = {
  ban: AuditLogEvent.MemberBanAdd,
  unban: AuditLogEvent.MemberBanRemove,
  kick: AuditLogEvent.MemberKick,
  member_update: AuditLogEvent.MemberUpdate,
  role_update: AuditLogEvent.MemberRoleUpdate,
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  automod_block: AuditLogEvent.AutoModerationBlockMessage,
};

interface SearchAuditLogArgs {
  guildId: string; // injected by runner
  client: Client<true>; // injected by runner
  action_type?: string;
  executor_id?: string;
  target_id?: string;
  limit?: number;
}

export async function searchAuditLog(args: SearchAuditLogArgs) {
  const guild =
    args.client.guilds.cache.get(args.guildId) ??
    (await args.client.guilds.fetch(args.guildId));

  const auditLogs = await guild.fetchAuditLogs({
    limit: 100,
    type: args.action_type ? ACTION_TYPE_MAP[args.action_type] : undefined,
    user: args.executor_id ?? undefined,
  });

  let entries = [...auditLogs.entries.values()];

  if (args.target_id) {
    entries = entries.filter((e) => {
      const target = e.target as { id?: string } | null;
      return target?.id === args.target_id;
    });
  }

  const limit = Math.min(args.limit ?? 25, 100);
  entries = entries.slice(0, limit);

  return entries.map((entry) => ({
    id: entry.id,
    action: AuditLogEvent[entry.action] ?? String(entry.action),
    executorId: entry.executor?.id ?? null,
    executorUsername: entry.executor?.username ?? null,
    targetId: (entry.target as { id?: string } | null)?.id ?? null,
    reason: entry.reason ?? null,
    createdAt: entry.createdTimestamp,
    changes: entry.changes?.map((c) => ({ key: c.key, old: c.old, new: c.new })) ?? [],
  }));
}
