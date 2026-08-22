export { type GuildConfig, getPermittedGuildIds, buildEmojiMap, resolvedModules } from "./guildConfig.ts";
import type { GuildConfig } from "./guildConfig.ts";

export interface Config {
  discordBotToken: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiContextLimit: number;
  databasePath: string;
  feedbackPath: string;
  guildConfig: Record<string, GuildConfig>;
  sushiiMcpUrl: string | undefined;
  sushiiMcpToken: string | undefined;
  exaApiKey: string | undefined;
  discordOAuthClientId: string | undefined;
  discordOAuthClientSecret: string | undefined;
  discordOAuthRedirectUri: string | undefined;
  mcpBridgePort: number;
  wikiSyncRepoUrl: string | undefined;
  wikiSyncCloneDir: string;
  wikiSyncInboxDir: string;
  wikiSyncAgentDir: string;
  wikiSyncIntervalMinutes: number;
  wikiSyncMaxMessagesPerSweep: number;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalPort(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in env var ${name}: ${raw}`);
  }
  return port;
}

import { readFileSync } from "fs";

function loadGuildConfig(): Record<string, GuildConfig> {
  const filePath = optional("GUILD_CONFIG_PATH", "./guild-config.json");
  let raw: Record<string, GuildConfig>;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to load guild config from ${filePath}: ${e}`);
  }
  return raw;
}

export const config: Config = {
  discordBotToken: required("DISCORD_BOT_TOKEN"),
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: optional("OPENAI_BASE_URL", "https://api.anthropic.com/v1"),
  openaiModel: optional("OPENAI_MODEL", "claude-opus-4-6"),
  openaiContextLimit: parseInt(optional("OPENAI_CONTEXT_LIMIT", "200000"), 10),
  databasePath: optional("DATABASE_PATH", "./data/sushii-agent.db"),
  feedbackPath: optional("FEEDBACK_PATH", "./data/feedback"),
  guildConfig: loadGuildConfig(),
  sushiiMcpUrl: process.env["SUSHII_MCP_URL"],
  sushiiMcpToken: process.env["SUSHII_MCP_TOKEN"],
  exaApiKey: process.env["EXA_API_KEY"],
  discordOAuthClientId: process.env["DISCORD_OAUTH_CLIENT_ID"],
  discordOAuthClientSecret: process.env["DISCORD_OAUTH_CLIENT_SECRET"],
  discordOAuthRedirectUri: process.env["DISCORD_OAUTH_REDIRECT_URI"],
  mcpBridgePort: optionalPort("MCP_BRIDGE_PORT", 8787),
  wikiSyncRepoUrl: process.env["WIKI_SYNC_REPO_URL"],
  wikiSyncCloneDir: optional("WIKI_SYNC_CLONE_DIR", "./data/wiki-sync/repo"),
  wikiSyncInboxDir: optional("WIKI_SYNC_INBOX_DIR", "./data/wiki-sync/inbox"),
  wikiSyncAgentDir: optional("WIKI_SYNC_AGENT_DIR", "./data/wiki-sync/agent"),
  wikiSyncIntervalMinutes: parseInt(optional("WIKI_SYNC_INTERVAL_MINUTES", "60"), 10),
  wikiSyncMaxMessagesPerSweep: parseInt(optional("WIKI_SYNC_MAX_MESSAGES_PER_SWEEP", "500"), 10),
};
