// Concrete SushiMcpHost — wraps SushiiMcpClient, mapping its ModCase/CrossServerBan shapes onto
// the neutral SushiMcpHost members declared in core/tools/hosts.ts.
import { SushiiMcpClient } from "../../../mcp/SushiiMcpClient.ts";
import "../../../core/tools/hosts.ts";

export class SushiMcpHost {
  private readonly client: SushiiMcpClient;

  constructor(baseUrl: string, token: string, private readonly guildId: string) {
    this.client = new SushiiMcpClient(baseUrl, token);
  }

  async getUserModHistory(args: { userId: string; limit?: number; beforeCaseId?: string }) {
    const cases = await this.client.getUserModHistory({
      guild_id: this.guildId,
      user_id: args.userId,
      limit: args.limit,
      before_case_id: args.beforeCaseId,
    });
    return cases.map((c) => ({
      caseId: c.caseId,
      action: c.action,
      userId: c.userId,
      userTag: c.userTag,
      actionTime: new Date(c.actionTime).getTime(),
      executorId: c.executorId ?? undefined,
      reason: c.reason ?? undefined,
    }));
  }

  async getUserCrossServerBans(userId: string) {
    const bans = await this.client.getUserCrossServerBans({ user_id: userId });
    return bans.map((b) => ({
      guildId: b.guildId,
      guildName: b.guildName ?? undefined,
      guildMembers: b.guildMembers,
      lookupDetailsOptIn: b.lookupDetailsOptIn,
      actionTime: b.actionTime ? new Date(b.actionTime).getTime() : undefined,
      reason: b.reason ?? undefined,
    }));
  }

  async getGuildRecentCases(limit?: number) {
    const cases = await this.client.getGuildRecentCases({ guild_id: this.guildId, limit });
    return cases.map((c) => ({
      caseId: c.caseId,
      action: c.action,
      userId: c.userId,
      userTag: c.userTag,
      actionTime: new Date(c.actionTime).getTime(),
      executorId: c.executorId ?? undefined,
      reason: c.reason ?? undefined,
    }));
  }
}
