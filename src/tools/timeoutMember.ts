import type { Client } from "discord.js";

export interface TimeoutMemberArgs {
  user_id: string;
  duration_ms: number;
  reason?: string;
  guildId: string;
  client: Client<true>;
  modImmuneRoleIds: string[];
  dryRun?: boolean;
}

export interface TimeoutMemberResult {
  ok: true;
  userId: string;
  durationMs: number;
  expiresAt: number;
  dryRun?: boolean;
}

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// The reason is shown to the timed-out user, so a rambling model-written one is
// truncated rather than passed through — it should only ever be a short category.
const MAX_REASON_LENGTH = 48;

function sanitizeReason(reason: string | undefined): string | undefined {
  const collapsed = reason?.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

export async function timeoutMember(
  args: TimeoutMemberArgs,
): Promise<TimeoutMemberResult | { error: string }> {
  const durationMs = Math.min(Math.max(args.duration_ms, 1000), MAX_TIMEOUT_MS);

  let guild;
  try {
    guild = args.client.guilds.cache.get(args.guildId) ?? await args.client.guilds.fetch(args.guildId);
  } catch (err) {
    return { error: `Failed to fetch guild: ${err}` };
  }

  let member;
  try {
    member = await guild.members.fetch(args.user_id);
  } catch {
    return { error: `User ${args.user_id} is not in the server or could not be fetched.` };
  }

  const memberRoleIds = [...member.roles.cache.keys()];
  const isImmune = args.modImmuneRoleIds.some((id) => memberRoleIds.includes(id));
  if (isImmune) {
    return { error: `Cannot timeout u:${args.user_id} — they have a mod-immune role. Send alert instead.` };
  }

  if (!args.dryRun) {
    try {
      await member.timeout(durationMs, sanitizeReason(args.reason));
    } catch (err) {
      return { error: `Discord API error applying timeout: ${err}` };
    }
  }

  return {
    ok: true,
    userId: args.user_id,
    durationMs,
    expiresAt: Date.now() + durationMs,
    ...(args.dryRun ? { dryRun: true } : {}),
  };
}
