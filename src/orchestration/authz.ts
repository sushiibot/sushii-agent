// Execution authz for runner/session capabilities. Default-deny; grant only when the caller is
// authorized (the owner in any space, or a principal trusted in the community that owns the
// space) and the capability is owner-grantable. NOT DM-restricted — authorized callers drive
// runners from guild channels too; a shared space grants nothing to a caller not authorized for it.
import type { AuthzInput, Capability, CanFn } from "./contracts.ts";
import { ownerPrincipalId, resolvePrincipal } from "./principals.ts";
import { isCommunityMember } from "./communities.ts";

export function spaceKey(surface: string, spaceId: string): string {
  return `${surface}:${spaceId}`;
}

// The one personal/DM space the owner is known to drive a runner from outside a team's shared
// spaces. Not a guild/shared space — a Discord guild thread's spaceId is a guildId, which never
// appears here. (Buzz never emits a "dm" space — its principal is a pubkey, not a Discord id.)
const PERSONAL_SPACES: ReadonlySet<string> = new Set([spaceKey("discord", "dm")]);

/** The capabilities the OWNER may exercise, from any space (DM or guild
 *  channel — only the owner's own principal ever qualifies, so a shared space grants nothing to
 *  others). Keyed by capability alone, so it works across surfaces whose spaceId isn't literally
 *  "dm" (Slack's is the teamId). */
const OWNER_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "runner.dispatch",
  "session.read",
  "session.resume",
  "session.interrupt",
  "session.stop",
]);

/** Surface prefix of a `surface:spaceId` key. A spaceId itself CAN contain ":" (buzz's is
 *  `buzz:https://relay.example`), so this only ever splits on the FIRST colon — the surface is
 *  everything before it, the spaceId is everything after. Don't change the split to "no colons in
 *  spaceId". */
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

/** Whether the caller is the owner — the only principal a personal (ownerOnly) runner serves. */
export function isOwnerCaller(principal: string, space: string): boolean {
  return resolvePrincipal(surfaceOf(space), principal)?.isOwner === true;
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

/** Default-deny: three conjunctions (caller is authorized for this space · capability
 *  owner-grantable · an owner principal exists). Authorized = the owner (any space) OR a principal
 *  trusted in the community that owns the space; NOT space-restricted for the owner, since only the
 *  owner's own principal ever resolves as owner. */
export const can: CanFn = ({ principal, capability, space }: AuthzInput): boolean => {
  if (!isAuthorized(surfaceOf(space), principal, space)) return false; // (1) owner OR community-trusted
  if (!OWNER_CAPABILITIES.has(capability)) return false; // (2) the capability is owner-grantable
  if (ownerPrincipalId() === undefined) return false; // (3) an owner principal exists at all
  return true;
};

/** Whether `space` is the hardcoded personal/DM space — used by the tool registry to hide runner
 *  tools outside it, independent of the per-call owner/capability check. */
export function isPersonalSpace(space: string): boolean {
  return PERSONAL_SPACES.has(space);
}
