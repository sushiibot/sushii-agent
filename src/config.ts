export { type GuildConfig, getPermittedGuildIds, buildEmojiMap, resolvedModules } from "./guildConfig.ts";
import type { GuildConfig } from "./guildConfig.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";
import { parseRelayUrls, parseWikiMap, parseAvatarMap } from "./surfaces/buzz/relayUrl.ts";

export interface Config {
  discordBotToken: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  compactionModel: string;
  /** Auto-derive durable memory from each finished turn (write-side of proactive memory). Default on;
   *  set MEMORY_DERIVER=0 to disable if the per-turn extraction cost isn't worth it. */
  memoryDeriverEnabled: boolean;
  /** Transcribe Discord voice messages to text (STT). Default on; VOICE_TRANSCRIPTION=0 disables. */
  transcriptionEnabled: boolean;
  /** OpenRouter transcription (ASR) model for voice messages. */
  transcriptionModel: string;
  openaiContextLimit: number;
  databasePath: string;
  feedbackPath: string;
  guildConfig: Record<string, GuildConfig>;
  /** Manual cross-platform identity registry (principal → identities), hand-maintained in
   *  principals.json (path via PRINCIPALS_PATH). Empty/unset → the registry is unconfigured and
   *  authz falls back to the legacy `ownerDiscordId` behavior. See orchestration/principals.ts. */
  principals: Record<string, PrincipalConfig>;
  sushiiMcpUrl: string | undefined;
  sushiiMcpToken: string | undefined;
  /** mnemosyne MCP server (streamable-http). Unset → the semantic memory backend is disabled and
   *  the local FTS provider is used instead. */
  mnemosyneMcpUrl: string | undefined;
  mnemosyneMcpToken: string | undefined;
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
  /** Public base URL of the bot's HTTP app (e.g. https://agent-mcp.sushii.bot), used to build the
   *  per-task live-stream viewer link. Unset → no web link is shown (Discord tail still works). */
  taskStreamBaseUrl: string | undefined;
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
    /** Fallback avatar URL for the kind:0 profile, used for any relay not in avatarMap. */
    avatarUrl: string | undefined;
    /** Per-relay avatar URL (relay → image URL). buzz media is auth-gated per relay, so each relay's
     *  profile must point at the avatar copy hosted on that relay. Falls back to avatarUrl. */
    avatarMap: Record<string, string>;
    /** Relay URL → Discord guild id whose synced wiki that community may read. A relay absent here
     *  gets no wiki tools, so each community can read only the one wiki it is explicitly mapped to. */
    wikiMap: Record<string, string>;
  };
  slack: {
    /** Bot token (xoxb-). Unset → the Slack surface is disabled. */
    botToken: string | undefined;
    /** App-level token (xapp-, needs `connections:write`) for Socket Mode. Unset → surface disabled.
     *  The surface starts only when BOTH tokens are present. */
    appToken: string | undefined;
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
    /** Explicit wiki → sources map (from WIKI_SYNC_SOURCES JSON). Lets one wiki be fed by many
     *  `(surface, spaceId)` sources. Empty → each enabled Discord guild is synthesized as its own
     *  single-source wiki (see modules/wiki-sync/sources.ts). */
    sources: Record<string, { sources: { surface: string; spaceId: string; statusChannelId?: string }[] }>;
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

/** Load + validate the manual principal registry. A missing DEFAULT file means "unconfigured" (empty
 *  → legacy fallback); an explicitly-set PRINCIPALS_PATH that can't be read or parsed is a
 *  misconfiguration and throws. Enforces the at-most-one-owner invariant at load. */
function loadPrincipals(): Record<string, PrincipalConfig> {
  const explicit = process.env["PRINCIPALS_PATH"];
  const filePath = explicit ?? "./principals.json";
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    if (explicit) throw new Error(`Failed to load principals from ${filePath}: ${e}`);
    return {};
  }
  let raw: Record<string, PrincipalConfig>;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid principals JSON in ${filePath}: ${e}`);
  }
  const owners = Object.keys(raw).filter((id) => raw[id]?.owner === true);
  if (owners.length > 1) {
    throw new Error(`principals: at most one principal may be owner (found ${owners.join(", ")})`);
  }
  return raw;
}

export const config: Config = {
  discordBotToken: required("DISCORD_BOT_TOKEN"),
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: optional("OPENAI_BASE_URL", "https://api.anthropic.com/v1"),
  openaiModel: optional("OPENAI_MODEL", "claude-opus-4-6"),
  // Model for the compaction summarize-fold. Runs over long histories, so a cheap model is ideal;
  // empty falls back to openaiModel.
  compactionModel: optional("COMPACTION_MODEL", ""),
  memoryDeriverEnabled: !["0", "false", "no"].includes(optional("MEMORY_DERIVER", "1").toLowerCase()),
  transcriptionEnabled: !["0", "false", "no"].includes(optional("VOICE_TRANSCRIPTION", "1").toLowerCase()),
  transcriptionModel: optional("TRANSCRIPTION_MODEL", "openai/whisper-large-v3"),
  openaiContextLimit: parseInt(optional("OPENAI_CONTEXT_LIMIT", "200000"), 10),
  databasePath: optional("DATABASE_PATH", "./data/sushii-agent.db"),
  feedbackPath: optional("FEEDBACK_PATH", "./data/feedback"),
  guildConfig: loadGuildConfig(),
  principals: loadPrincipals(),
  sushiiMcpUrl: process.env["SUSHII_MCP_URL"],
  sushiiMcpToken: process.env["SUSHII_MCP_TOKEN"],
  mnemosyneMcpUrl: process.env["MNEMOSYNE_MCP_URL"],
  mnemosyneMcpToken: process.env["MNEMOSYNE_MCP_TOKEN"],
  exaApiKey: process.env["EXA_API_KEY"],
  ownerDiscordId: process.env["OWNER_DISCORD_ID"],
  linearApiKey: process.env["LINEAR_API_KEY"],
  linearTeamId: process.env["LINEAR_TEAM_ID"],
  taskStreamBaseUrl: process.env["TASK_STREAM_BASE_URL"],
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
    avatarMap: parseAvatarMap(process.env["BUZZ_AVATAR_MAP"]),
    wikiMap: parseWikiMap(process.env["BUZZ_WIKI_MAP"]),
  },
  slack: {
    botToken: process.env["SLACK_BOT_TOKEN"],
    appToken: process.env["SLACK_APP_TOKEN"],
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
    sources: parseWikiSources(process.env["WIKI_SYNC_SOURCES"]),
  },
};

function parseWikiSources(raw: string | undefined): Config["wikiSync"]["sources"] {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid WIKI_SYNC_SOURCES JSON: ${e}`);
  }
}
