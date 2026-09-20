// P0 authz stub (BRIEF): owner-only AND a hardcoded personal/DM-space allowlist. Both required —
// a guild/shared space must never offer runner.dispatch. Phase 2 (U2.1) swaps in real tables
// behind this same CanFn signature.
import type { AuthzInput, Capability, CanFn } from "./contracts.ts";
import { config } from "../config.ts";

export function spaceKey(surface: string, spaceId: string): string {
  return `${surface}:${spaceId}`;
}

// Personal/DM spaces the owner may drive a runner from. Not guild/shared spaces — a Discord
// guild thread's spaceId is a guildId, which never appears here.
const PERSONAL_SPACE_CAPABILITIES: ReadonlyMap<string, ReadonlySet<Capability>> = new Map([
  [
    spaceKey("discord", "dm"),
    new Set<Capability>(["runner.dispatch", "session.read", "session.resume", "session.interrupt"]),
  ],
  [
    spaceKey("buzz", "dm"),
    new Set<Capability>(["runner.dispatch", "session.read", "session.resume", "session.interrupt"]),
  ],
]);

/** Same owner signal ops-triage tools gate on (config.ownerDiscordId) — one source of truth
 *  instead of a second, independently-configured env var that can silently drift out of sync. */
function ownerPrincipal(): string | undefined {
  return config.ownerDiscordId;
}

/** Default-deny: both checks must pass, independently, before any capability is granted. */
export const can: CanFn = ({ principal, capability, space }: AuthzInput): boolean => {
  const owner = ownerPrincipal();
  if (!owner || principal !== owner) return false;

  const offered = PERSONAL_SPACE_CAPABILITIES.get(space);
  return offered?.has(capability) ?? false;
};

/** Whether `space` is one of the hardcoded personal/DM spaces at all — used by the tool registry
 *  to hide runner tools outside those spaces, independent of the per-call owner/capability check. */
export function isPersonalSpace(space: string): boolean {
  return PERSONAL_SPACE_CAPABILITIES.has(space);
}
