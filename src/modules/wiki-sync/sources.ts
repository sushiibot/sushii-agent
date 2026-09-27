import { config } from "../../config.ts";
import { resolveTeam } from "../../orchestration/teams.ts";

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

/**
 * The wiki a `(surface, spaceId)` space feeds and/or reads, or undefined when it has none. The
 * owning team's `wiki` fields (teams.json) are the only source of truth — no self-wiki synthesis,
 * no env-map fallback.
 */
export function wikiFor(surface: string, spaceId: string): WikiAssignment | undefined {
  const team = resolveTeam(surface, spaceId);
  const wikiId = team?.wiki?.wikiId;
  if (!wikiId) return undefined;
  const space = team.spaces.find((s) => s.surface === surface && s.spaceId === spaceId);
  if (!space?.wiki) return undefined;
  return { wikiId, feeds: space.wiki === "source", reads: true };
}

/**
 * The `wikiId → sources` map, for the sweep. Every team space with `wiki: "source"` feeds its
 * team's wiki; `statusChannelId` comes from the space's own field.
 */
export function getWikiSources(): Map<string, WikiSource[]> {
  const bySpace = new Map<string, { wikiId: string; statusChannelId?: string }>();

  for (const entry of Object.values(config.teams)) {
    const wikiId = entry.wiki?.wikiId;
    if (!wikiId) continue;
    for (const space of entry.spaces) {
      if (space.wiki !== "source") continue;
      const key = spaceKey(space.surface, space.spaceId);
      bySpace.set(key, { wikiId, statusChannelId: space.statusChannelId });
    }
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

/** The wiki a Discord guild's `/wiki-sync` invocation targets, or undefined when the guild's team
 *  space doesn't feed a wiki at all — a guild in no team's `wiki: "source"` role has no wiki to
 *  sweep, so its `/wiki-sync` shouldn't be registered (see command.ts's wikiSyncCommandGuildIds). */
export function resolveWikiIdForGuild(guildId: string): string | undefined {
  const wiki = wikiFor("discord", guildId);
  return wiki?.feeds ? wiki.wikiId : undefined;
}
