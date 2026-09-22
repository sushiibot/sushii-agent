// Concrete SushiMcpHost — wraps SushiiMcpClient, mapping its ModCase/CrossServerBan shapes onto
// the neutral SushiMcpHost members declared in core/tools/hosts.ts.
import { SushiiMcpClient } from "../../../mcp/SushiiMcpClient.ts";
import "../../../core/tools/hosts.ts";

// A host is built per turn (buildHosts runs in each message handler), but the client keeps a live MCP
// connection, so cache it by endpoint — otherwise every turn would leak a fresh connection. baseUrl +
// token are process-global config and guildId is passed per call, so one client serves all guilds.
const clientCache = new Map<string, SushiiMcpClient>();

function getSharedClient(baseUrl: string, token: string): SushiiMcpClient {
  const key = `${baseUrl}|${token}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new SushiiMcpClient(baseUrl, token);
    clientCache.set(key, client);
  }
  return client;
}

/** Close every cached sushii-mcp connection — call on process shutdown. */
export async function closeSharedSushiMcpClients(): Promise<void> {
  const clients = [...clientCache.values()];
  clientCache.clear();
  await Promise.all(clients.map((c) => c.close()));
}

export class SushiMcpHost {
  private readonly client: SushiiMcpClient;

  constructor(baseUrl: string, token: string, private readonly guildId: string) {
    this.client = getSharedClient(baseUrl, token);
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
