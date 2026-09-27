import type { ToolContext, ToolEntry } from "../../contracts.ts";
import { config } from "../../../config.ts";
import { isAuthorized, isPersonalSpace, spaceKey } from "../../../orchestration/authz.ts";
import { principalsConfigured, resolvePrincipal } from "../../../orchestration/principals.ts";
import { isMemberOfAnyTeam, isTeamMember, listCommunities, resolveCommunity } from "../../../orchestration/communities.ts";
import {
  renderTeamConfig,
  renderTeamList,
  resolveTeamConfig,
  resolveTeamConfigById,
  type SpaceStats,
} from "../../../orchestration/teamConfig.ts";

const DENIED = "This tool is limited to trusted team members.";

/** Denial string, or undefined when the caller is the owner or a trusted member of this space's
 *  team — OR, from a DM with no community of its own, a trusted member of at least one team
 *  elsewhere (so they can reach the DM listing below; per-team detail is re-checked there). */
function requireAuthorized(ctx: ToolContext): string | undefined {
  const userId = ctx.owner?.userId;
  if (!userId) return DENIED;
  const { surface, spaceId } = ctx.space;
  if (principalsConfigured()) {
    if (isAuthorized(surface, userId, spaceKey(surface, spaceId))) return undefined;
    if (isPersonalSpace(spaceKey(surface, spaceId)) && !resolveCommunity(surface, spaceId)) {
      const principal = resolvePrincipal(surface, userId);
      if (principal && isMemberOfAnyTeam(principal.principalId)) return undefined;
    }
    return DENIED;
  }
  return userId === config.ownerDiscordId ? undefined : "This tool is owner-only.";
}

export const teamConfigEntry: ToolEntry = {
  name: "team_config",
  definition: {
    name: "team_config",
    description:
      "Show the configuration of the team this conversation belongs to: its Discord/Slack/buzz spaces, persona, enabled modules, roles, wiki wiring, trusted members, and per-space memory/context status. Read-only; covers only this team. " +
      "In a DM, instead lists the teams you're the owner of or a trusted member of; pass `team` (a team id from that list) to see one team's detail. Outside a DM, `team` is ignored — a team channel only ever shows its own team.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "DM only: a team id to view in detail, from the list team_config returns without it." },
      },
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const denied = requireAuthorized(ctx);
    if (denied) return { content: denied };

    const { surface, spaceId } = ctx.space;
    const userId = ctx.owner?.userId;
    // A fail-safe isPrivate (buzz "unknown" channel type) is not a confirmed private space — never
    // trust it for disclosure, only the memory-scoping decision it was designed for.
    const detailed = ctx.isPrivate === true && ctx.privacyUnverified !== true;
    const stats: SpaceStats = (sid) => ({
      memoryEntries: ctx.memory.count(sid),
      // Only aggregate counts may cross a team (memory wall) — never the entries or context text.
      contextChars: ctx.memory.getServerContext(sid)?.length ?? 0,
    });

    // A DM placeholder spaceId (discord "dm", buzz "dm") never appears in communities.json, so it
    // never resolves to a team; a Slack DM's spaceId is its real teamId and DOES resolve, so it
    // keeps showing that team below instead of hitting this branch.
    if (isPersonalSpace(spaceKey(surface, spaceId)) && !resolveCommunity(surface, spaceId)) {
      const principal = userId ? resolvePrincipal(surface, userId) : undefined;
      // requireAuthorized already enforced owner-only when principals aren't configured, so an
      // unresolved principal in that regime still means "the legacy owner".
      const isOwner = principal ? principal.isOwner : !principalsConfigured();

      const requestedTeam = typeof input.team === "string" ? input.team : undefined;
      if (requestedTeam) {
        const isMember = isOwner || (principal && isTeamMember(principal.principalId, requestedTeam));
        // Same denial whether the team doesn't exist or the caller isn't a member of it — a probing
        // caller can't tell the two apart.
        if (!isMember) return { content: DENIED };
        const view = resolveTeamConfigById(requestedTeam, stats, detailed);
        if (!view) return { content: DENIED };
        return { content: renderTeamConfig(view, ctx.space) };
      }

      const teamIds = isOwner
        ? listCommunities().map((c) => c.id)
        : listCommunities()
            .filter((c) => principal && isTeamMember(principal.principalId, c.id))
            .map((c) => c.id);
      return { content: renderTeamList(teamIds) };
    }

    return { content: renderTeamConfig(resolveTeamConfig(surface, spaceId, stats, detailed), ctx.space) };
  },
};

export const TEAM_TOOL_ENTRIES: ToolEntry[] = [teamConfigEntry];
