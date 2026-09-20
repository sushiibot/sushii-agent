export { type GuildConfig, getPermittedGuildIds, buildEmojiMap, resolvedModules } from "./guildConfig.ts";
import type { GuildConfig } from "./guildConfig.ts";
import { parseRelayUrls, parseWikiMap } from "./surfaces/buzz/relayUrl.ts";

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
  /** Discord user ID allowed to invoke ops-triage tools — gate is enforced at tool-execution time, not just list-assembly. */
  ownerDiscordId: string | undefined;
  linearApiKey: string | undefined;
  linearTeamId: string | undefined;
  /** Grafana's own HTTP API — Loki/Tempo aren't independently reachable from sushii-agent's deploy host, so every log/trace query goes through Grafana's datasource-proxy at this base URL. */
  grafanaBaseUrl: string | undefined;
  grafanaApiToken: string | undefined;
  discordOAuthClientId: string | undefined;
  discordOAuthClientSecret: string | undefined;
  discordOAuthRedirectUri: string | undefined;
  mcpBridgePort: number;
  buzz: {
    /** Nostr private key (hex or nsec). Unset → the buzz surface is disabled entirely. */
    privateKey: string | undefined;
    /** Relay base URLs (one community per relay). Comma-separated in BUZZ_RELAY_URL; empty lets the
     *  `buzz` CLI use its own default (http://localhost:3000). Each becomes its own poll loop. */
    relayUrls: string[];
    /** NIP-OA owner-attestation tag JSON (optional). */
    authTag: string | undefined;
    /** Display name the bot publishes for itself (kind:0 profile) on each relay. */
    displayName: string;
    /** Avatar for the kind:0 profile (hosted URL or data: URL). Unset → no picture published. */
    avatarUrl: string | undefined;
    /** Relay URL → Discord guild id whose synced wiki that community may read. A relay absent here
     *  gets no wiki tools, so each community can read only the one wiki it is explicitly mapped to. */
    wikiMap: Record<string, string>;
  };
  wikiSync: {
    repoUrl: string | undefined;
    /** Access token for an https:// repoUrl. Unused for ssh:// (ssh-agent handles auth instead). */
    httpsToken: string | undefined;
    cloneDir: string;
    inboxDir: string;
    agentDir: string;
    /** Bun.cron expression, e.g. "0 9 * * *" for daily at 9am UTC (Bun.cron schedules are always UTC). */
    cronSchedule: string;
    maxMessagesPerSweep: number;
    /** Independent of openaiModel -- must be vision-capable since wiki-sync reads image/PDF attachments from the inbox. */
    model: string;
    contextLimit: number;
    /** Per-turn output cap passed to the provider as max_tokens. Required by Pi's registerProvider API (no "unbounded" option). */
    maxOutputTokens: number;
  };
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
  ownerDiscordId: process.env["OWNER_DISCORD_ID"],
  linearApiKey: process.env["LINEAR_API_KEY"],
  linearTeamId: process.env["LINEAR_TEAM_ID"],
  grafanaBaseUrl: process.env["GRAFANA_BASE_URL"],
  grafanaApiToken: process.env["GRAFANA_API_TOKEN"],
  discordOAuthClientId: process.env["DISCORD_OAUTH_CLIENT_ID"],
  discordOAuthClientSecret: process.env["DISCORD_OAUTH_CLIENT_SECRET"],
  discordOAuthRedirectUri: process.env["DISCORD_OAUTH_REDIRECT_URI"],
  mcpBridgePort: optionalPort("MCP_BRIDGE_PORT", 8787),
  buzz: {
    privateKey: process.env["BUZZ_PRIVATE_KEY"],
    relayUrls: parseRelayUrls(process.env["BUZZ_RELAY_URL"]),
    authTag: process.env["BUZZ_AUTH_TAG"],
    displayName: optional("BUZZ_DISPLAY_NAME", "sushii-agent"),
    avatarUrl: process.env["BUZZ_AVATAR_URL"],
    wikiMap: parseWikiMap(process.env["BUZZ_WIKI_MAP"]),
  },
  wikiSync: {
    repoUrl: process.env["WIKI_SYNC_REPO_URL"],
    httpsToken: process.env["WIKI_SYNC_HTTPS_TOKEN"],
    cloneDir: optional("WIKI_SYNC_CLONE_DIR", "./data/wiki-sync/repo"),
    inboxDir: optional("WIKI_SYNC_INBOX_DIR", "./data/wiki-sync/inbox"),
    agentDir: optional("WIKI_SYNC_AGENT_DIR", "./data/wiki-sync/agent"),
    cronSchedule: optional("WIKI_SYNC_CRON_SCHEDULE", "0 9 * * *"),
    maxMessagesPerSweep: parseInt(optional("WIKI_SYNC_MAX_MESSAGES_PER_SWEEP", "5000"), 10),
    // deepseek/deepseek-v4.1-flash: vision-capable (input_modalities: text, image) on
    // OpenRouter -- pin this explicit versioned slug, not an unversioned -latest alias (e.g.
    // deepseek/deepseek-flash-latest), which floats to whatever's newest and could silently
    // change behavior underneath a fixed price/config.
    model: optional("WIKI_SYNC_MODEL", "deepseek/deepseek-v4.1-flash"),
    // piSession.ts resolves the model's real context window from OpenRouter's catalog at
    // session start, so this only takes effect if that lookup fails (catalog down/slow, or the
    // model isn't listed) -- a sweep shouldn't hard-fail just because of that. 800k is a safe
    // buffer under DeepSeek V4 Flash 0731's real ~1,048,576-token window at time of writing.
    contextLimit: parseInt(optional("WIKI_SYNC_CONTEXT_LIMIT", "800000"), 10),
    // A real per-turn output cap, not the model's full completion ceiling -- pi-ai falls back to
    // this value as the request's max_tokens whenever a call doesn't set its own (see
    // clampMaxTokensToContext), and it also becomes compaction's reserveTokens. Setting it to the
    // model's entire max_completion_tokens made every request's max_tokens alone equal the whole
    // context window, so any non-empty prompt pushed prompt_tokens + max_tokens past the model's
    // real ceiling and got rejected before generating anything. 64k is generous for a wiki-edit
    // turn (markdown file writes) while leaving most of contextLimit for actual input.
    maxOutputTokens: parseInt(optional("WIKI_SYNC_MAX_OUTPUT_TOKENS", "65536"), 10),
  },
};
