// Execution authz for runner/session capabilities. Two regimes, selected by whether the manual
// principal registry is configured:
//   - CONFIGURED (principals.json non-empty): default-deny; grant only when the caller is authorized
//     (the owner in any space, or a principal trusted in the community that owns the space) and the
//     capability is owner-grantable. NOT DM-restricted — authorized callers drive runners from guild
//     channels too; a shared space grants nothing to a caller not authorized for it.
//   - UNCONFIGURED (empty/unset registry): today's exact behavior — the legacy `ownerDiscordId` id
//     AND the hardcoded per-space (discord:dm-only) allowlist. Unchanged; never widened.
import type { AuthzInput, Capability, CanFn } from "./contracts.ts";
import { config } from "../config.ts";
import { ownerPrincipalId, principalsConfigured, resolvePrincipal } from "./principals.ts";
import { isCommunityMember } from "./communities.ts";

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
  // Forward-declared for buzz DM routing, not yet wired: buzz never emits a "dm" space today
  // (its principal is a pubkey, not an ownerDiscordId), so this entry is currently unreachable.
  [
    spaceKey("buzz", "dm"),
    new Set<Capability>(["runner.dispatch", "session.read", "session.resume", "session.interrupt"]),
  ],
]);

/** Same owner signal ops-triage tools gate on (config.ownerDiscordId) — one source of truth
 *  instead of a second, independently-configured env var that can silently drift out of sync.
 *  Used only in the UNCONFIGURED (legacy) regime. */
function legacyOwner(): string | undefined {
  return config.ownerDiscordId;
}

/** The capabilities the OWNER may exercise in the CONFIGURED regime, from any space (DM or guild
 *  channel — only the owner's own principal ever qualifies, so a shared space grants nothing to
 *  others). Keyed by capability alone, so it works across surfaces whose spaceId isn't literally
 *  "dm" (Slack's is the teamId). Includes `session.stop`, which the legacy allowlist omits. */
const OWNER_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "runner.dispatch",
  "session.read",
  "session.resume",
  "session.interrupt",
  "session.stop",
]);

/** Surface prefix of a `surface:spaceId` key. spaceIds never contain ":", so the first segment is
 *  the surface. */
function surfaceOf(space: string): string {
  const i = space.indexOf(":");
  return i === -1 ? space : space.slice(0, i);
}

/** spaceId suffix of a `surface:spaceId` key — the exact inverse of spaceKey(). No colon → "",
 *  which resolveCommunity rejects (default-deny for a malformed key). */
function spaceIdOf(space: string): string {
  const i = space.indexOf(":");
  return i === -1 ? "" : space.slice(i + 1);
}

/** The single authorization predicate (CONFIGURED regime): the caller is authorized when they resolve
 *  to the owner principal (superset, any space) OR to a principal listed as trusted in the community
 *  that owns `space`. Default-deny: an unresolved caller, or a trusted-but-not-owner principal in a
 *  space belonging to no community / a different community, → false. Authorization is by principalId,
 *  so a member's grants span their linked identities across surfaces. */
export function isAuthorized(surface: string, userId: string, space: string): boolean {
  const resolved = resolvePrincipal(surface, userId);
  if (!resolved) return false;
  if (resolved.isOwner) return true;
  return isCommunityMember(resolved.principalId, surface, spaceIdOf(space));
}

/** Default-deny. Configured registry → three conjunctions (caller is authorized for this space ·
 *  capability owner-grantable · an owner principal exists). Authorized = the owner (any space) OR a
 *  principal trusted in the community that owns the space; NOT space-restricted for the owner, since
 *  only the owner's own principal ever resolves as owner. Unconfigured → the legacy owner id +
 *  per-space (discord:dm-only) allowlist, unchanged. */
export const can: CanFn = ({ principal, capability, space }: AuthzInput): boolean => {
  if (principalsConfigured()) {
    if (!isAuthorized(surfaceOf(space), principal, space)) return false; // (1) owner OR community-trusted
    if (!OWNER_CAPABILITIES.has(capability)) return false; // (2) the capability is owner-grantable
    if (ownerPrincipalId() === undefined) return false; // (3) an owner principal exists at all
    return true;
  }

  const owner = legacyOwner();
  if (!owner || principal !== owner) return false;

  const offered = PERSONAL_SPACE_CAPABILITIES.get(space);
  return offered?.has(capability) ?? false;
};

/** Whether `space` is one of the hardcoded personal/DM spaces at all — used by the tool registry
 *  to hide runner tools outside those spaces, independent of the per-call owner/capability check. */
export function isPersonalSpace(space: string): boolean {
  return PERSONAL_SPACE_CAPABILITIES.has(space);
}
