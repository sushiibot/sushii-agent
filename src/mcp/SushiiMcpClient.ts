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

// Server is stateless — create a fresh client+transport per call so there's
// no persistent connection and startup never crashes on unreachable URL.
export class SushiiMcpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async callTool(name: string, args: Record<string, unknown>) {
    const client = new Client(
      { name: "sushii-agent", version: "1.0.0" },
      { capabilities: {} },
    );

    const transport = new StreamableHTTPClientTransport(new URL(this.baseUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.token}` },
      },
    });

    await client.connect(transport);

    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => {});
    }
  }

  async getUserModHistory(args: GetUserModHistoryArgs): Promise<ModCase[]> {
    const result = await this.callTool(
      "get_user_mod_history",
      args as unknown as Record<string, unknown>,
    );
    return JSON.parse(this.extractText(result.content)) as ModCase[];
  }

  async getUserCrossServerBans(
    args: GetUserCrossServerBansArgs,
  ): Promise<CrossServerBan[]> {
    const result = await this.callTool(
      "get_user_cross_server_bans",
      args as unknown as Record<string, unknown>,
    );
    return JSON.parse(this.extractText(result.content)) as CrossServerBan[];
  }

  async getGuildRecentCases(
    args: GetGuildRecentCasesArgs,
  ): Promise<ModCase[]> {
    const result = await this.callTool(
      "get_guild_recent_cases",
      args as unknown as Record<string, unknown>,
    );
    return JSON.parse(this.extractText(result.content)) as ModCase[];
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
