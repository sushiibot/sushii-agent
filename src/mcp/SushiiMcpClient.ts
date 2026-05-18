import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ModCase {
  guildId: string;
  caseId: string;
  action: string;
  actionTime: string;
  userId: string;
  userTag: string;
  executorId: string | null;
  reason: string | null;
  attachments: string[];
}

export interface CrossServerBan {
  guildId: string;
  guildName: string | null;
  guildMembers: number;
  reason: string | null;
  actionTime: string | null;
  lookupDetailsOptIn: boolean;
}

export interface GetUserModHistoryArgs {
  guild_id: string;
  user_id: string;
  limit?: number;
  before_case_id?: string;
}

export interface GetUserCrossServerBansArgs {
  user_id: string;
}

export interface GetGuildRecentCasesArgs {
  guild_id: string;
  limit?: number;
}

export class SushiiMcpClient {
  private client: Client;

  constructor(baseUrl: string, token: string) {
    this.client = new Client(
      { name: "sushii-agent", version: "1.0.0" },
      { capabilities: {} },
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });

    this.client.connect(transport);
  }

  async getUserModHistory(args: GetUserModHistoryArgs): Promise<ModCase[]> {
    const result = await this.client.callTool({
      name: "get_user_mod_history",
      arguments: args as unknown as Record<string, unknown>,
    });

    const text = this.extractText(result.content);
    return JSON.parse(text) as ModCase[];
  }

  async getUserCrossServerBans(
    args: GetUserCrossServerBansArgs,
  ): Promise<CrossServerBan[]> {
    const result = await this.client.callTool({
      name: "get_user_cross_server_bans",
      arguments: args as unknown as Record<string, unknown>,
    });

    const text = this.extractText(result.content);
    return JSON.parse(text) as CrossServerBan[];
  }

  async getGuildRecentCases(
    args: GetGuildRecentCasesArgs,
  ): Promise<ModCase[]> {
    const result = await this.client.callTool({
      name: "get_guild_recent_cases",
      arguments: args as unknown as Record<string, unknown>,
    });

    const text = this.extractText(result.content);
    return JSON.parse(text) as ModCase[];
  }

  private extractText(
    content: { type: string; [key: string]: unknown }[] | unknown,
  ): string {
    if (!Array.isArray(content)) {
      throw new Error("Unexpected MCP tool response: content is not an array");
    }
    const first = content[0] as { type: string; text?: string } | undefined;
    if (!first || first.type !== "text" || typeof first.text !== "string") {
      throw new Error("Unexpected MCP tool response: no text content");
    }
    return first.text;
  }
}
