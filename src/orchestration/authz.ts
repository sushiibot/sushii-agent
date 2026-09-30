// Who may use the owner-gated tools in a space: the owner in any space, or a principal trusted in
// the team that owns the space. A shared space grants nothing to a caller not authorized for it.
import { resolvePrincipal } from "./principals.ts";
import { isTeamMember, resolveTeam } from "./teams.ts";

export function spaceKey(surface: string, spaceId: string): string {
  return `${surface}:${spaceId}`;
}

// The owner's personal/DM space, outside any team's shared spaces. A Discord guild thread's spaceId
// is a guildId, which never appears here. (Buzz never emits a "dm" space — its principal is a pubkey, not a Discord id.)
const PERSONAL_SPACES: ReadonlySet<string> = new Set([spaceKey("discord", "dm")]);

/** spaceId suffix of a `surface:spaceId` key — the exact inverse of spaceKey(). No colon → "",
 *  which resolveTeam rejects (default-deny for a malformed key). */
function spaceIdOf(space: string): string {
  const i = space.indexOf(":");
  return i === -1 ? "" : space.slice(i + 1);
}

/** The single authorization predicate (CONFIGURED regime): the caller is authorized when they resolve
 *  to the owner principal (superset, any space), OR to a principal listed as trusted in the team
 *  that owns `space`, OR — on a non-Discord space whose team sets `trustSpaceMembers` — when they
 *  present any non-empty userId at all (that space is private/invite-only, so being in it already
 *  vetted them; Discord guilds are public, so they always need an explicit trusted member or the
 *  owner). Default-deny otherwise. Authorization by principalId spans a member's linked identities
 *  across surfaces; the trustSpaceMembers path needs no principal at all. */
export function isAuthorized(surface: string, userId: string, space: string): boolean {
  const resolved = resolvePrincipal(surface, userId);
  if (resolved?.isOwner) return true;
  const spaceId = spaceIdOf(space);
  if (resolved && isTeamMember(resolved.principalId, surface, spaceId)) return true;
  if (surface !== "discord" && userId.trim().length > 0 && resolveTeam(surface, spaceId)?.trustSpaceMembers === true) return true;
  return false;
}

/** Whether `space` is the hardcoded personal/DM space, which marks a turn as private when the
 *  surface doesn't say. */
export function isPersonalSpace(space: string): boolean {
  return PERSONAL_SPACES.has(space);
}
