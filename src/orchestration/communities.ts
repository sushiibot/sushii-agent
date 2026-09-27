// Community concept: an admin-declared grouping of one community's spaces (a Discord guild, a Slack
// team, a buzz relay) plus its per-community scoping (its own Linear account, its wiki reference),
// hand-maintained in communities.json (path via COMMUNITIES_PATH, mirroring PRINCIPALS_PATH). The
// file IS the source of truth — no discovery. Resolves (surface, spaceId) → community for
// per-scope ops-triage (Linear) routing.
//
// HARD WALL: this module MUST NOT be reachable from the memory-scope path (banks.ts / agentCore's
// memoryScope). A community groups multiple surfaces; if a memory spaceId resolved through it,
// `sushii-space-<spaceId>` would merge public facts across Discord/Slack/buzz memberships.
import { config } from "../config.ts";
import { normalizeRelayUrl } from "../surfaces/buzz/relayUrl.ts";

export interface CommunitySpace {
  surface: string;
  spaceId: string;
}

/** Vetted people beyond the owner. `trusted: true` = the elevated set (same tools the owner gets),
 *  scoped to this community's spaces. Deliberately flat — no per-capability granularity. */
export type CommunityMembers = Record<string, { trusted?: boolean }>;

/** Raw per-community entry as it appears in communities.json (keyed by community id). */
export interface CommunityConfig {
  spaces: CommunitySpace[];
  /** Reference to an existing wiki (wikiId == guildId). Does NOT drive wiki-sync source derivation. */
  wiki?: { wikiId: string };
  /** This community's own Linear account. Absent → ops-triage falls through to the default (SUSHI). */
  linear?: { apiKey: string; teamId: string };
  /** Authorized principals in this community, keyed by principalId. */
  members?: CommunityMembers;
}

export interface Community {
  id: string;
  spaces: CommunitySpace[];
  wiki?: { wikiId: string };
  linear?: { apiKey: string; teamId: string };
  members?: CommunityMembers;
}

interface CommunityIndex {
  bySpace: Map<string, Community>;
}

function keyOf(surface: string, spaceId: string): string {
  return `${surface} ${spaceId}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSpaceId(surface: string, spaceId: string): string {
  return surface === "buzz" && spaceId.startsWith("buzz:")
    ? `buzz:${normalizeRelayUrl(spaceId.slice("buzz:".length))}`
    : spaceId;
}

/** Validate + normalize the raw communities.json shape, called at config load. Buzz spaceIds are
 *  normalized the same way as the relay poll loop's cursor key, so `buzz:wss://Relay.Example/` and
 *  `buzz:https://relay.example` collide as the same space instead of silently splitting one
 *  community's config across two keys. Throws `Error("communities: <reason>")` on any shape violation. */
export function parseCommunities(raw: unknown): Record<string, CommunityConfig> {
  if (!isPlainObject(raw)) throw new Error("communities: top-level value must be an object");

  const out: Record<string, CommunityConfig> = {};
  for (const [id, entryRaw] of Object.entries(raw)) {
    if (!isPlainObject(entryRaw)) throw new Error(`communities: entry "${id}" must be an object`);

    const spacesRaw = entryRaw["spaces"];
    if (!Array.isArray(spacesRaw)) throw new Error(`communities: "${id}".spaces must be an array`);
    const spaces: CommunitySpace[] = spacesRaw.map((s, i) => {
      if (!isPlainObject(s) || !isNonEmptyString(s["surface"]) || !isNonEmptyString(s["spaceId"])) {
        throw new Error(`communities: "${id}".spaces[${i}] must be {surface: string, spaceId: string}`);
      }
      return { surface: s["surface"], spaceId: normalizeSpaceId(s["surface"], s["spaceId"]) };
    });

    const membersRaw = entryRaw["members"];
    let members: CommunityMembers | undefined;
    if (membersRaw !== undefined) {
      if (!isPlainObject(membersRaw)) throw new Error(`communities: "${id}".members must be an object`);
      for (const [principalId, m] of Object.entries(membersRaw)) {
        if (!isPlainObject(m)) throw new Error(`communities: "${id}".members["${principalId}"] must be an object`);
        if (m["trusted"] !== undefined && typeof m["trusted"] !== "boolean") {
          throw new Error(`communities: "${id}".members["${principalId}"].trusted must be a boolean`);
        }
      }
      members = membersRaw as CommunityMembers;
    }

    out[id] = {
      spaces,
      wiki: entryRaw["wiki"] as CommunityConfig["wiki"],
      linear: entryRaw["linear"] as CommunityConfig["linear"],
      members,
    };
  }
  return out;
}

/** Build the reverse (surface, spaceId) → community index, enforcing that no space is claimed by two
 *  communities. Throws on a duplicate — surfaced at config load (config.ts) and on the lazy rebuild. */
export function buildCommunityIndex(communities: Record<string, CommunityConfig>): CommunityIndex {
  const bySpace = new Map<string, Community>();
  for (const [id, entry] of Object.entries(communities)) {
    const community: Community = { id, spaces: entry?.spaces ?? [], wiki: entry?.wiki, linear: entry?.linear, members: entry?.members };
    for (const s of community.spaces) {
      const k = keyOf(s.surface, s.spaceId);
      const existing = bySpace.get(k);
      if (existing) {
        throw new Error(`communities: space ${s.surface}/${s.spaceId} is claimed by both "${existing.id}" and "${id}"`);
      }
      bySpace.set(k, community);
    }
  }
  return { bySpace };
}

// Reference-identity cache: rebuilt only when `config.communities` is REASSIGNED (never mutate the
// map in place — an in-place edit leaves this index stale). Lazy so config load order is irrelevant
// and tests can swap the whole map between cases. Same pattern as principals.ts.
let cache: { source: Record<string, CommunityConfig>; index: CommunityIndex } | null = null;

function index(): CommunityIndex {
  if (!cache || cache.source !== config.communities) {
    cache = { source: config.communities, index: buildCommunityIndex(config.communities) };
  }
  return cache.index;
}

/** Resolve (surface, spaceId) → its community, or undefined when the space belongs to none. */
export function resolveCommunity(surface: string, spaceId: string): Community | undefined {
  if (spaceId.length === 0) return undefined;
  return index().bySpace.get(keyOf(surface, spaceId));
}

/** Whether `principalId` is a trusted member of the community that owns (surface, spaceId). Pure;
 *  false when the space belongs to no community or the principal isn't listed as trusted there. */
export function isCommunityMember(principalId: string, surface: string, spaceId: string): boolean {
  return resolveCommunity(surface, spaceId)?.members?.[principalId]?.trusted === true;
}

/** All communities, by id — for a DM listing where there's no (surface, spaceId) to resolve from. */
export function listCommunities(): Community[] {
  return Object.entries(config.communities).map(([id, entry]) => ({
    id,
    spaces: entry.spaces ?? [],
    wiki: entry.wiki,
    linear: entry.linear,
    members: entry.members,
  }));
}

/** A community by its own id, independent of any space — for a DM's `team` lookup. */
export function getCommunity(teamId: string): Community | undefined {
  const entry = config.communities[teamId];
  return entry ? { id: teamId, spaces: entry.spaces ?? [], wiki: entry.wiki, linear: entry.linear, members: entry.members } : undefined;
}
