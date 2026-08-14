import { upsertMemory } from "../db/memory.ts";

// Live/mutable server state that's already tracked by other tools (get_current_member_info,
// list_guild_roles, list_automod_rules, etc.) — storing it here would let it silently go stale
// and get surfaced alongside current truth with no way to tell which is which.
const AUTHORITATIVE_STATE_PATTERNS: RegExp[] = [
  /\b(is|isn'?t|is not|was)\s+(a\s+|an\s+)?(mod(erator)?|admin(istrator)?)\b/i,
  /\b(promot|demot)ed\b/i,
  /\bhas\s+(the\s+)?.*\brole\b/i,
  /\b(role|permission)s?\s+(granted|revoked|assigned|removed)\b/i,
  /\b(banned|timed?\s*out|kicked|muted)\b/i,
  /\bautomod\s+(rule|config|keyword|threshold)/i,
];

function findAuthoritativeStateMatch(content: string): RegExp | undefined {
  return AUTHORITATIVE_STATE_PATTERNS.find((pattern) => pattern.test(content));
}

export function writeMemoryTool({
  guildId,
  title,
  content,
}: {
  guildId: string;
  title: string;
  content: string;
}) {
  if (findAuthoritativeStateMatch(content)) {
    return {
      error:
        "This looks like live/mutable server state (mod status, roles, permissions, ban/timeout, automod config) rather than a durable fact. That data is already tracked live — re-fetch it instead of storing it in memory, where it could go stale.",
    };
  }
  return upsertMemory(guildId, title, content);
}
