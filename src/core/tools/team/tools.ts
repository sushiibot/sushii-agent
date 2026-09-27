import type { ToolContext, ToolEntry } from "../../contracts.ts";
import { config } from "../../../config.ts";
import { isAuthorized, isPersonalSpace, spaceKey } from "../../../orchestration/authz.ts";
import { principalsConfigured } from "../../../orchestration/principals.ts";
import { resolveCommunity } from "../../../orchestration/communities.ts";
import { renderTeamConfig, resolveTeamConfig, type SpaceStats } from "../../../orchestration/teamConfig.ts";

/** Denial string, or undefined when the caller is the owner or a trusted member of this space's team. */
function requireAuthorized(ctx: ToolContext): string | undefined {
  const userId = ctx.owner?.userId;
  if (!userId) return "This tool is limited to trusted team members.";
  if (principalsConfigured()) {
    return isAuthorized(ctx.space.surface, userId, spaceKey(ctx.space.surface, ctx.space.spaceId))
      ? undefined
      : "This tool is limited to trusted team members.";
  }
  return userId === config.ownerDiscordId ? undefined : "This tool is owner-only.";
}

export const teamConfigEntry: ToolEntry = {
  name: "team_config",
  definition: {
    name: "team_config",
    description:
      "Show the configuration of the team this conversation belongs to: its Discord/Slack/buzz spaces, persona, enabled modules, roles, wiki wiring, trusted members, and per-space memory/context status. Read-only; covers only this team.",
    parameters: { type: "object", properties: {} },
  },
  requiresHosts: [],
  async execute(_input, ctx) {
    const denied = requireAuthorized(ctx);
    if (denied) return { content: denied };

    const { surface, spaceId } = ctx.space;
    // A DM placeholder spaceId (discord "dm", buzz "dm") never appears in communities.json, so it
    // never resolves to a team; a Slack DM's spaceId is its real teamId and DOES resolve, so it
    // keeps showing that team below instead of hitting this early return.
    if (isPersonalSpace(spaceKey(surface, spaceId)) && !resolveCommunity(surface, spaceId)) {
      return { content: "DMs aren't part of a team; ask from a team channel." };
    }

    const stats: SpaceStats = (sid) => ({
      memoryEntries: ctx.memory.count(sid),
      // Only aggregate counts may cross a team (memory wall) — never the entries or context text.
      contextChars: ctx.memory.getServerContext(sid)?.length ?? 0,
    });
    return { content: renderTeamConfig(resolveTeamConfig(surface, spaceId, stats, ctx.isPrivate === true), ctx.space) };
  },
};

export const TEAM_TOOL_ENTRIES: ToolEntry[] = [teamConfigEntry];
