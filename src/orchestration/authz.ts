// Execution authz for runner/session capabilities. Two regimes, selected by whether the manual
// principal registry is configured:
//   - CONFIGURED (principals.json non-empty): default-deny; grant only when the caller resolves to
//     the OWNER principal, the turn is a private/DM context, and the capability is in the DM set.
//   - UNCONFIGURED (empty/unset registry): today's exact behavior — the legacy `ownerDiscordId` id
//     AND the hardcoded per-space capability allowlist. The new `isPrivate` signal is ignored here
//     so an empty registry can never be widened by a DM-shaped space.
// A guild/shared space must never offer runner.dispatch under either regime.
import type { AuthzInput, Capability, CanFn } from "./contracts.ts";
import { config } from "../config.ts";
import { ownerPrincipalId, principalsConfigured, resolvePrincipal } from "./principals.ts";

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

/** The capabilities an owner may exercise from a DM/personal space in the CONFIGURED regime. Unlike
 *  the legacy per-space allowlist, this is keyed by capability alone (the DM-ness is proven by the
 *  threaded `isPrivate`), so it works across surfaces whose DM spaceId isn't literally "dm" (Slack's
 *  is the teamId). Includes `session.stop`, which the legacy allowlist omits (see below). */
const DM_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
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

/** Default-deny. Configured registry → five conjunctions (known owner principal · isOwner · private
 *  space · capability in the DM set · an owner principal exists); unconfigured → the legacy owner id
 *  + per-space allowlist, unchanged. */
export const can: CanFn = ({ principal, capability, space, isPrivate }: AuthzInput): boolean => {
  if (principalsConfigured()) {
    const resolved = resolvePrincipal(surfaceOf(space), principal); // (1) caller is a known principal
    if (!resolved) return false;
    if (!resolved.isOwner) return false; // (2) and that principal is the owner
    if (isPrivate !== true) return false; // (3) the turn is a private/DM context
    if (!DM_CAPABILITIES.has(capability)) return false; // (4) the capability is DM-grantable
    if (ownerPrincipalId() === undefined) return false; // (5) an owner principal exists at all
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
