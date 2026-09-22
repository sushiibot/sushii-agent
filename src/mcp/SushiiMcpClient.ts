import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getLogger } from "../logger.ts";

const logger = getLogger("mcp/sushii-client");

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

/** The low-level MCP connection the client manages. The default binds a real Streamable HTTP client;
 *  tests supply a fake to exercise connect/reuse/reset without a live server. */
export interface SushiiMcpConnection {
  connect(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown }>;
  close(): Promise<void>;
}

export interface SushiiMcpClientOptions {
  /** Test seam: build the underlying MCP connection. Defaults to a real Streamable HTTP client. */
  createClient?: () => SushiiMcpConnection;
}

// Lazy so an unreachable URL can't crash startup — nothing connects until the first tool call. The
// connection is then reused across calls; a transport failure drops it so the next call reconnects.
export class SushiiMcpClient {
  private readonly createClient: () => SushiiMcpConnection;
  private clientPromise: Promise<SushiiMcpConnection> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    options?: SushiiMcpClientOptions,
  ) {
    this.createClient = options?.createClient ?? (() => this.defaultCreateClient());
  }

  private defaultCreateClient(): SushiiMcpConnection {
    const client = new Client(
      { name: "sushii-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.baseUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.token}` },
      },
    });
    return {
      connect: () => client.connect(transport),
      callTool: async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        return { content: (result as { content: unknown }).content };
      },
      close: () => client.close(),
    };
  }

  private ensureConnected(): Promise<SushiiMcpConnection> {
    if (this.clientPromise === null) {
      this.clientPromise = (async () => {
        const client = this.createClient();
        await client.connect();
        return client;
      })().catch((err) => {
        this.clientPromise = null; // don't cache a failed connect — a later call retries
        throw err;
      });
    }
    return this.clientPromise;
  }

  private reset(): void {
    const pending = this.clientPromise;
    this.clientPromise = null;
    void pending?.then((c) => c.close()).catch(() => {});
  }

  /** Close the reused connection (if any) — for graceful process shutdown. */
  async close(): Promise<void> {
    const pending = this.clientPromise;
    this.clientPromise = null;
    if (pending) await pending.then((c) => c.close()).catch(() => {});
  }

  // Retry once on transport failure: unlike the every-turn mnemosyne seam, mod-history lookups are
  // rare, so the reused connection can be idle-reaped between them — the caller (a Discord tool) would
  // otherwise see a spurious error on the first lookup after any quiet period. Bounded at one retry so
  // a genuinely-down server still fails fast.
  private async callTool(name: string, args: Record<string, unknown>, retry = true): Promise<{ content: unknown }> {
    const client = await this.ensureConnected();
    try {
      return await client.callTool(name, args);
    } catch (err) {
      logger.debug({ err, tool: name }, "sushii MCP call failed; resetting connection");
      this.reset();
      if (retry) return this.callTool(name, args, false);
      throw err;
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
