// Ports the three MODERATION_DISPATCH entries that call SushiiMcpClient (get_user_mod_history,
// get_user_cross_server_bans, get_guild_recent_cases) onto SushiMcpHost.
import type { ToolEntry } from "../../contracts.ts";
import "../hosts.ts";
import { formatModCaseLine } from "../format.ts";

export const getUserModHistoryEntry: ToolEntry<"mcp"> = {
  name: "get_user_mod_history",
  definition: {
    name: "get_user_mod_history",
    description: "Get a user's moderation case history for this guild (from sushii-mcp).",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Discord user ID" },
        limit: { type: "number", description: "Maximum number of cases to return." },
        before_case_id: { type: "string", description: "Paginate before this case ID." },
      },
      required: ["user_id"],
    },
  },
  requiresHosts: ["mcp"],
  async execute(input, ctx) {
    const userId = input.user_id as string;
    try {
      const cases = await ctx.mcp.getUserModHistory({
        userId,
        limit: input.limit as number | undefined,
        beforeCaseId: input.before_case_id as string | undefined,
      });
      if (cases.length === 0) return { content: `Mod history for u:${userId}: (no cases found — this user has no recorded cases)` };
      return { content: [`Mod history for u:${userId}:`, ...cases.map(formatModCaseLine)].join("\n") };
    } catch (err) {
      return { content: String(err) };
    }
  },
};

export const getUserCrossServerBansEntry: ToolEntry<"mcp"> = {
  name: "get_user_cross_server_bans",
  definition: {
    name: "get_user_cross_server_bans",
    description: "Look up a user's known bans across other sushii-moderated servers.",
    parameters: {
      type: "object",
      properties: { user_id: { type: "string", description: "Discord user ID" } },
      required: ["user_id"],
    },
  },
  requiresHosts: ["mcp"],
  async execute(input, ctx) {
    const userId = input.user_id as string;
    try {
      const bans = await ctx.mcp.getUserCrossServerBans(userId);
      if (bans.length === 0) return { content: `Cross-server bans for u:${userId}: (none found)` };
      const lines = bans.map((b) => {
        const name = b.lookupDetailsOptIn ? (b.guildName ?? "unknown") : "[redacted]";
        const parts = [`  guild:${b.guildId} ${name} (${b.guildMembers} members) optIn:${b.lookupDetailsOptIn}`];
        if (b.actionTime) parts.push(`    banned: t:${b.actionTime}`);
        if (b.reason) parts.push(`    reason: ${b.reason}`);
        return parts.join("\n");
      });
      return { content: [`Cross-server bans for u:${userId}:`, ...lines].join("\n") };
    } catch (err) {
      return { content: String(err) };
    }
  },
};

export const getGuildRecentCasesEntry: ToolEntry<"mcp"> = {
  name: "get_guild_recent_cases",
  definition: {
    name: "get_guild_recent_cases",
    description: "Get the guild's most recent moderation cases (general server activity, not user-specific).",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Maximum number of cases to return." } },
      required: [],
    },
  },
  requiresHosts: ["mcp"],
  async execute(input, ctx) {
    try {
      const cases = await ctx.mcp.getGuildRecentCases(input.limit as number | undefined);
      if (cases.length === 0) return { content: "(no recent cases found for this guild)" };
      return {
        content: [
          "Guild's most recent cases — general server activity, not evidence about the user under investigation. Follow one up only if it connects to them; otherwise don't pivot to these users:",
          ...cases.map(formatModCaseLine),
        ].join("\n"),
      };
    } catch (err) {
      return { content: String(err) };
    }
  },
};

export const MCP_TOOL_ENTRIES: ToolEntry<"mcp">[] = [getUserModHistoryEntry, getUserCrossServerBansEntry, getGuildRecentCasesEntry];
