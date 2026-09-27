import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { resolveCommunity } from "../../orchestration/communities.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";

const logger = getLogger("wiki-sync:sources");

/** One feed into a wiki: a `(surface, spaceId)` pair with an optional status channel for that
 *  surface. Many sources can share one `wikiId`. */
export interface WikiSource {
  surface: string;
  spaceId: string;
  statusChannelId?: string;
}

/** What a `(surface, spaceId)` space is to a wiki: which wiki, and whether it feeds and/or reads it. */
export interface WikiAssignment {
  wikiId: string;
  feeds: boolean;
  reads: boolean;
}

function spaceKey(surface: string, spaceId: string): string {
  return `${surface} ${spaceId}`;
}

function splitSpaceKey(key: string): [surface: string, spaceId: string] {
  const i = key.indexOf(" ");
  return [key.slice(0, i), key.slice(i + 1)];
}

/** The team (community) assignment for a space, or undefined when the team either doesn't exist,
 *  has no `wiki.wikiId`, or this space has no `wiki` role in it. */
function teamWikiFor(surface: string, spaceId: string): WikiAssignment | undefined {
  const community = resolveCommunity(surface, spaceId);
  const wikiId = community?.wiki?.wikiId;
  if (!wikiId) return undefined;
  const space = community.spaces.find((s) => s.surface === surface && s.spaceId === spaceId);
  if (!space?.wiki) return undefined;
  return { wikiId, feeds: space.wiki === "source", reads: true };
}

/** The buzz relay key `BUZZ_WIKI_MAP` is keyed by: the normalized relay URL, or "default" for the
 *  bare `buzz` spaceId (no relay URL configured). Mirrors the spaceId construction in index.ts. */
function buzzRelayKey(spaceId: string): string {
  return spaceId === "buzz" ? "default" : spaceId.slice("buzz:".length);
}

/** The pre-team env-map assignment for a space: an explicit `WIKI_SYNC_SOURCES` entry, then
 *  `BUZZ_WIKI_MAP` (buzz, read-only), then a Discord guild's own wiki-sync-enabled self-wiki. */
function legacyWikiFor(surface: string, spaceId: string): WikiAssignment | undefined {
  for (const [wikiId, entry] of Object.entries(config.wikiSync.sources)) {
    if (entry.sources.some((s) => s.surface === surface && s.spaceId === spaceId)) {
      return { wikiId, feeds: true, reads: true };
    }
  }
  if (surface === "buzz") {
    const wikiId = config.buzz.wikiMap[buzzRelayKey(spaceId)];
    if (wikiId) return { wikiId, feeds: false, reads: true };
  }
  if (surface === "discord" && getWikiSyncEnabledGuildIds().includes(spaceId)) {
    return { wikiId: spaceId, feeds: true, reads: true };
  }
  return undefined;
}

// Startup-time warn dedup: the team/legacy disagreement is a static config mismatch, not a
// per-call condition, so a caller hitting wikiFor a thousand times in a sweep must not spam a
// thousand identical warnings.
const warnedDisagreements = new Set<string>();

/** Test-only: clears the warn-once cache between cases that reuse the same (surface, spaceId). */
export function __resetWikiWarnDedup(): void {
  warnedDisagreements.clear();
}

/**
 * The wiki a `(surface, spaceId)` space feeds and/or reads, or undefined when it has none.
 * The owning team's `wiki` fields (communities.json) are the source of truth; the legacy env
 * maps (`WIKI_SYNC_SOURCES`, `BUZZ_WIKI_MAP`, a Discord guild's own wiki-sync module) apply only
 * when the team says nothing. If both are configured for the same space and disagree, the team
 * wins and one warning is logged (not per call).
 */
export function wikiFor(surface: string, spaceId: string): WikiAssignment | undefined {
  const team = teamWikiFor(surface, spaceId);
  const legacy = legacyWikiFor(surface, spaceId);

  if (team) {
    if (legacy && legacy.wikiId !== team.wikiId) {
      const key = spaceKey(surface, spaceId);
      if (!warnedDisagreements.has(key)) {
        warnedDisagreements.add(key);
        logger.warn(
          { surface, spaceId, teamWikiId: team.wikiId, legacyWikiId: legacy.wikiId },
          "team wiki disagrees with a legacy wiki-sync env mapping for this space — the team definition wins",
        );
      }
    }
    return team;
  }
  return legacy;
}

/**
 * The `wikiId → sources` map, for the sweep. Precedence per `(surface, spaceId)`: a team `source`
 * space, then an explicit `WIKI_SYNC_SOURCES` entry, then a synthesized Discord self-wiki (any
 * wiki-sync-enabled guild not already claimed by either of those) — so nothing is double-ingested.
 * `statusChannelId` precedence: the team space's own, then the explicit entry's, then
 * guild-config's `wiki.statusChannelId` fallback.
 */
export function getWikiSources(): Map<string, WikiSource[]> {
  const bySpace = new Map<string, { wikiId: string; statusChannelId?: string }>();

  for (const entry of Object.values(config.communities)) {
    const wikiId = entry.wiki?.wikiId;
    if (!wikiId) continue;
    for (const space of entry.spaces) {
      if (space.wiki !== "source") continue;
      bySpace.set(spaceKey(space.surface, space.spaceId), { wikiId, statusChannelId: space.statusChannelId });
    }
  }

  for (const [wikiId, entry] of Object.entries(config.wikiSync.sources)) {
    for (const s of entry.sources) {
      const key = spaceKey(s.surface, s.spaceId);
      const claimed = bySpace.get(key);
      if (claimed) {
        if (claimed.wikiId !== wikiId && !warnedDisagreements.has(key)) {
          warnedDisagreements.add(key);
          logger.warn(
            { surface: s.surface, spaceId: s.spaceId, teamWikiId: claimed.wikiId, legacyWikiId: wikiId },
            "team wiki disagrees with a legacy wiki-sync env mapping for this space — the team definition wins",
          );
        }
        continue;
      }
      const statusChannelId =
        s.statusChannelId ?? (s.surface === "discord" ? config.guildConfig[s.spaceId]?.wiki?.statusChannelId : undefined);
      bySpace.set(key, { wikiId, statusChannelId });
    }
  }

  for (const guildId of getWikiSyncEnabledGuildIds()) {
    const key = spaceKey("discord", guildId);
    if (bySpace.has(key)) continue;
    bySpace.set(key, { wikiId: guildId, statusChannelId: config.guildConfig[guildId]?.wiki?.statusChannelId });
  }

  const map = new Map<string, WikiSource[]>();
  for (const [key, { wikiId, statusChannelId }] of bySpace) {
    const [surface, spaceId] = splitSpaceKey(key);
    const list = map.get(wikiId) ?? [];
    list.push({ surface, spaceId, statusChannelId });
    map.set(wikiId, list);
  }
  return map;
}

/** The wiki a Discord guild's `/wiki-sync` invocation targets: whatever `wikiFor` resolves for
 *  (discord, guildId), defaulting to the guild id itself when nothing maps it. */
export function resolveWikiIdForGuild(guildId: string): string {
  return wikiFor("discord", guildId)?.wikiId ?? guildId;
}
