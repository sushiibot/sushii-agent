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

export interface CommunitySpace {
  surface: string;
  spaceId: string;
}

/** Raw per-community entry as it appears in communities.json (keyed by community id). */
export interface CommunityConfig {
  spaces: CommunitySpace[];
  /** Reference to an existing wiki (wikiId == guildId). Does NOT drive wiki-sync source derivation. */
  wiki?: { wikiId: string };
  /** This community's own Linear account. Absent → ops-triage falls through to the default (SUSHI). */
  linear?: { apiKey: string; teamId: string };
}

export interface Community {
  id: string;
  spaces: CommunitySpace[];
  wiki?: { wikiId: string };
  linear?: { apiKey: string; teamId: string };
}

interface CommunityIndex {
  bySpace: Map<string, Community>;
}

function keyOf(surface: string, spaceId: string): string {
  return `${surface} ${spaceId}`;
}

/** Build the reverse (surface, spaceId) → community index, enforcing that no space is claimed by two
 *  communities. Throws on a duplicate — surfaced at config load (config.ts) and on the lazy rebuild. */
export function buildCommunityIndex(communities: Record<string, CommunityConfig>): CommunityIndex {
  const bySpace = new Map<string, Community>();
  for (const [id, entry] of Object.entries(communities)) {
    const community: Community = { id, spaces: entry?.spaces ?? [], wiki: entry?.wiki, linear: entry?.linear };
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
