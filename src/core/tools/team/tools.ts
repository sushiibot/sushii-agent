import type { ToolContext, ToolEntry } from "../../contracts.ts";
import { config } from "../../../config.ts";
import { isAuthorized, isPersonalSpace, spaceKey } from "../../../orchestration/authz.ts";
import { principalsConfigured } from "../../../orchestration/principals.ts";
import { listCommunities, resolveCommunity } from "../../../orchestration/communities.ts";
import {
  renderTeamConfig,
  renderTeamList,
  resolveTeamConfig,
  resolveTeamConfigById,
  type SpaceStats,
} from "../../../orchestration/teamConfig.ts";

const DENIED = "This tool is limited to trusted team members.";

/** Denial string, or undefined when the caller is the owner or a trusted member of this space's team. */
function requireAuthorized(ctx: ToolContext): string | undefined {
  const userId = ctx.owner?.userId;
  if (!userId) return DENIED;
  const { surface, spaceId } = ctx.space;
  if (principalsConfigured()) {
    return isAuthorized(surface, userId, spaceKey(surface, spaceId)) ? undefined : DENIED;
  }
  return userId === config.ownerDiscordId ? undefined : "This tool is owner-only.";
}

export const teamConfigEntry: ToolEntry = {
  name: "team_config",
  definition: {
    name: "team_config",
    description:
      "Show the configuration of the team this conversation belongs to: its Discord/Slack/buzz spaces, persona, enabled modules, roles, wiki wiring, trusted members, and per-space memory/context status. Read-only; covers only this team. " +
      "In the owner's DM, instead lists every team; pass `team` (a team id from that list) to see one team's detail. Outside a DM, `team` is ignored — a team channel only ever shows its own team.",
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
    // A fail-safe isPrivate (buzz "unknown" channel type) is not a confirmed private space — never
    // trust it for disclosure, only the memory-scoping decision it was designed for.
    const detailed = ctx.isPrivate === true && ctx.privacyUnverified !== true;
    const stats: SpaceStats = (sid) => ({
      memoryEntries: ctx.memory.count(sid),
      // Only aggregate counts may cross a team (memory wall) — never the entries or context text.
      contextChars: ctx.memory.getServerContext(sid)?.length ?? 0,
    });

    // A DM placeholder space (discord "dm") belongs to no team and only the owner is authorized
    // there, so it's the one place a Discord-only team's details can be read privately. A Slack DM's
    // spaceId is its real teamId, so it resolves to that team below instead.
    if (isPersonalSpace(spaceKey(surface, spaceId)) && !resolveCommunity(surface, spaceId)) {
      const requestedTeam = typeof input.team === "string" ? input.team : undefined;
      if (!requestedTeam) return { content: renderTeamList(listCommunities().map((c) => c.id)) };
      const view = resolveTeamConfigById(requestedTeam, stats, detailed);
      return { content: view ? renderTeamConfig(view, ctx.space) : `No team "${requestedTeam}".` };
    }

    return { content: renderTeamConfig(resolveTeamConfig(surface, spaceId, stats, detailed), ctx.space) };
  },
};

export const TEAM_TOOL_ENTRIES: ToolEntry[] = [teamConfigEntry];
