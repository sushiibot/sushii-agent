export { type GuildConfig, getPermittedGuildIds, buildEmojiMap, resolvedModules } from "./guildConfig.ts";
import type { GuildConfig } from "./guildConfig.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";
import type { TeamConfig } from "./orchestration/teams.ts";
import { parseTeams, buildTeamIndex } from "./orchestration/teams.ts";
import { parseRelayUrls } from "./surfaces/buzz/relayUrl.ts";
import { getLogger } from "./logger.ts";
import { z } from "zod";
import { isLoopback, parseIp } from "./surfaces/web/peers.ts";

const logger = getLogger("config");

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
  /** Derived solely from each team's discord blocks (+ each discord space's own statusChannelId) —
   *  see teamGuildConfigs/applyStatusChannelOverrides. A guild not in any team has no entry. */
  guildConfig: Record<string, GuildConfig>;
  /** Manual cross-platform identity registry (principal → identities), hand-maintained in
   *  principals.json (path via PRINCIPALS_PATH). Missing/empty file + OWNER_DISCORD_ID set →
   *  a single owner principal is synthesized from it. Neither set → empty map, nobody is owner
   *  (default deny). See loadPrincipals below and orchestration/principals.ts. */
  principals: Record<string, PrincipalConfig>;
  /** Team grouping (team id → its spaces + per-team scoping), hand-maintained in teams.json
   *  (path via TEAMS_PATH). Empty/unset → unconfigured; ops-triage Linear routing falls through
   *  to the global default. See orchestration/teams.ts. */
  teams: Record<string, TeamConfig>;
  sushiiMcpUrl: string | undefined;
  sushiiMcpToken: string | undefined;
  /** mnemosyne MCP server (streamable-http). Unset → the semantic memory backend is disabled and
   *  the local FTS provider is used instead. */
  mnemosyneMcpUrl: string | undefined;
  mnemosyneMcpToken: string | undefined;
  exaApiKey: string | undefined;
  /** Seeds the synthesized owner principal when principals.json is absent (see resolveOwnerPrincipals),
   *  and drives owner-DM routing in the Discord gateway. Does not itself gate any tool. */
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
  /** Port the workspace transport listens on (ORCH_PORT). Default 8788, apart from mcpBridgePort's 8787. */
  orchPort: number;
  /** Secret the workspace presents on `runner/register` (ORCH_SECRET). Unset → every registration is refused. */
  orchSecret: string | undefined;
  /** Route owner DMs to the personal-agent workspace when it is connected (DM_WORKSPACE_ENABLED). Default off. */
  dmWorkspaceEnabled: boolean;
  /** Surface that gets the workspace's proactive messages and approval prompts (WORKSPACE_PREFERRED_SURFACE). Default discord. */
  workspacePreferredSurface: string;
  /** What an owner Discord DM does (OWNER_DM_MODE): `workspace` routes it to the personal agent, `redirect`
   *  only answers with a pointer to the web app. Independent of dmWorkspaceEnabled. Default `redirect` when
   *  the preferred surface is web, else `workspace`. */
  ownerDmMode: OwnerDmMode;
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
    /** Fallback avatar URL for the kind:0 profile, used for any relay space with no team
     *  `buzz.avatarUrl` (see orchestration/teams.ts's buzzAvatarFor). */
    avatarUrl: string | undefined;
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
  };
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface WebConfig {
  port: number;
  /** The only address the server listens on: the bot's fixed IP on its dedicated web network. */
  bindAddr: string;
  ownerLogin: string;
  distDir: string;
  /** Local-dev stand-in for the Serve identity header; only set when bound to loopback outside production. */
  devLogin: string | undefined;
  /** Exact peer IPs allowed to carry the identity header (the Serve host's side of the web network). */
  trustedPeers: string[];
  /** Undefined when the VAPID keys are absent or incomplete: push endpoints are off. */
  push: WebPushConfig | undefined;
  /** Why push is off although some VAPID env was set. */
  pushDisabledReason?: string;
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());

const webEnvSchema = z.object({
  WEB_OWNER_LOGIN: optionalString,
  WEB_BIND_ADDR: z.preprocess(emptyToUndefined, z.string().trim().refine((v) => parseIp(v) !== null, "must be an IP address").default("127.0.0.1")),
  WEB_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(8790)),
  WEB_DIST_DIR: z.preprocess(emptyToUndefined, z.string().default("/app/web/build")),
  WEB_DEV_LOGIN: optionalString,
  WEB_TRUSTED_PEERS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default("127.0.0.1")
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
      .refine((ips) => ips.length > 0 && ips.every((ip) => parseIp(ip) !== null), "must be a comma-separated list of exact IPs (no CIDR ranges)"),
  ),
  NODE_ENV: optionalString,
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: optionalString,
});

function parseVapid(e: z.infer<typeof webEnvSchema>): { push?: WebPushConfig; reason?: string } {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = e;
  if (!publicKey && !privateKey) return {};
  if (!publicKey || !privateKey) return { reason: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together" };
  if (!subject) return { reason: "VAPID_SUBJECT is required when the VAPID keys are set" };
  if (!/^(mailto:|https:)/.test(subject)) return { reason: "VAPID_SUBJECT must be a mailto: or https: URL" };
  return { push: { publicKey, privateKey, subject } };
}

/** Parses the web gateway env. Throws on an invalid gateway setting; a bad VAPID setup only turns push off.
 *  Not called at import time, so a bad value here can never take the rest of the bot down. */
export function parseWebConfig(env: Record<string, string | undefined>): WebConfig | undefined {
  if (!env["WEB_OWNER_LOGIN"]?.trim()) return undefined;
  const e = webEnvSchema.parse(env);
  if (!e.WEB_OWNER_LOGIN) return undefined;
  const { push, reason } = parseVapid(e);
  const production = e.NODE_ENV?.toLowerCase() === "production";
  return {
    port: e.WEB_PORT,
    bindAddr: e.WEB_BIND_ADDR,
    ownerLogin: e.WEB_OWNER_LOGIN,
    distDir: e.WEB_DIST_DIR,
    devLogin: !production && isLoopback(e.WEB_BIND_ADDR) ? e.WEB_DEV_LOGIN : undefined,
    trustedPeers: e.WEB_TRUSTED_PEERS,
    push,
    ...(reason ? { pushDisabledReason: reason } : {}),
  };
}

export type OwnerDmMode = "workspace" | "redirect";

/** A typo must not quietly reopen owner DMs to the agent, so an unknown value is a startup error. Unset
 *  follows the preferred surface, so moving personal chat to web alone closes the Discord DM path. */
export function parseOwnerDmMode(raw: string | undefined, preferredSurface: string): OwnerDmMode {
  const value = raw?.trim().toLowerCase() || (preferredSurface.trim().toLowerCase() === "web" ? "redirect" : "workspace");
  if (value === "workspace" || value === "redirect") return value;
  throw new Error(`Invalid OWNER_DM_MODE: ${raw} (expected "workspace" or "redirect")`);
}

function preferredSurface(): string {
  return optional("WORKSPACE_PREFERRED_SURFACE", "discord").trim() || "discord";
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

/** Reconciles a file-loaded principal registry with OWNER_DISCORD_ID. A non-empty registry is used
 *  as-is — never merged — but a declared owner whose discord identity differs from the env var only
 *  warns (the file wins). An empty registry (missing/empty file) with OWNER_DISCORD_ID set
 *  synthesizes a single owner principal from it; with neither set, the registry stays empty and
 *  nobody is owner (default deny). Factored out of loadPrincipals, with `warn` injectable, so
 *  synthesis/mismatch logic is testable without touching the filesystem or the real logger. */
export function resolveOwnerPrincipals(
  raw: Record<string, PrincipalConfig>,
  ownerDiscordId: string | undefined,
  warn: (ctx: Record<string, unknown>, msg: string) => void = (ctx, msg) => logger.warn(ctx, msg),
): Record<string, PrincipalConfig> {
  const ownerId = Object.keys(raw).find((id) => raw[id]?.owner === true);
  if (ownerId) {
    const fileOwnerDiscord = raw[ownerId]?.identities?.discord;
    if (ownerDiscordId && fileOwnerDiscord && fileOwnerDiscord !== ownerDiscordId) {
      warn(
        { principalId: ownerId, fileOwnerDiscord, ownerDiscordId },
        "principals.json owner's discord identity differs from OWNER_DISCORD_ID; the file wins",
      );
    }
    return raw;
  }
  if (Object.keys(raw).length === 0 && ownerDiscordId) {
    return { owner: { owner: true, identities: { discord: ownerDiscordId } } };
  }
  return raw;
}

/** Load + validate the manual principal registry. A missing DEFAULT file means "empty" (subject to
 *  OWNER_DISCORD_ID synthesis below); an explicitly-set PRINCIPALS_PATH that can't be read or parsed
 *  is a misconfiguration and throws. Enforces the at-most-one-owner invariant at load. */
function loadPrincipals(): Record<string, PrincipalConfig> {
  const explicit = process.env["PRINCIPALS_PATH"];
  const filePath = explicit ?? "./principals.json";
  let content: string | undefined;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    if (explicit) throw new Error(`Failed to load principals from ${filePath}: ${e}`);
  }
  let raw: Record<string, PrincipalConfig> = {};
  if (content !== undefined) {
    try {
      raw = JSON.parse(content);
    } catch (e) {
      throw new Error(`Invalid principals JSON in ${filePath}: ${e}`);
    }
  }
  const owners = Object.keys(raw).filter((id) => raw[id]?.owner === true);
  if (owners.length > 1) {
    throw new Error(`principals: at most one principal may be owner (found ${owners.join(", ")})`);
  }
  return resolveOwnerPrincipals(raw, process.env["OWNER_DISCORD_ID"]);
}

function parseTeamsJson(content: string, filePath: string): Record<string, TeamConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid teams JSON in ${filePath}: ${e}`);
  }
  const teams = parseTeams(raw);
  buildTeamIndex(teams);
  return teams;
}

/** Load + validate the team grouping, the sole source of per-space configuration. TEAMS_PATH set →
 *  it wins outright, and a failure to read/parse it throws (an explicit path is a promise the file
 *  is there). Unset → `./teams.json` if present, else unconfigured (empty). The read and the parse
 *  are two separate try blocks: an unreadable default path is "no teams.json", but an existing,
 *  invalid one must still throw — teams.json is the only place a guild's config comes from now, so
 *  swallowing its parse error would silently strip every guild's config instead of failing loudly.
 *  `readFile` is injectable so this is testable without real files (mirrors resolveOwnerPrincipals's
 *  injectable `warn`). Shape validation and buzz spaceId normalization live in parseTeams (teams.ts);
 *  buildTeamIndex then runs on the normalized output so two spellings of one relay collide as a
 *  duplicate at boot, not later. */
export function resolveTeamsConfig(
  teamsPathEnv: string | undefined,
  readFile: (filePath: string) => string,
): Record<string, TeamConfig> {
  if (teamsPathEnv) {
    let content: string;
    try {
      content = readFile(teamsPathEnv);
    } catch (e) {
      throw new Error(`Failed to load teams from ${teamsPathEnv}: ${e}`);
    }
    return parseTeamsJson(content, teamsPathEnv);
  }

  let content: string;
  try {
    content = readFile("./teams.json");
  } catch {
    return {};
  }
  return parseTeamsJson(content, "./teams.json");
}

function loadTeams(): Record<string, TeamConfig> {
  return resolveTeamsConfig(process.env["TEAMS_PATH"], (p) => readFileSync(p, "utf8"));
}

/** Discord guild configs derived from team discord spaces, keyed by guild id: the space's inline
 *  `discord` block with its own `statusChannelId` (if any) folded in as `wiki.statusChannelId` — the
 *  one place wiki-sync looks for a guild's status channel. A discord space with no `discord` block
 *  gets no entry (never synthesized from just a statusChannelId with no `allowedRoles` — resolvedModules()
 *  defaulting to `["moderation"]` and command.ts's `hasAny(...guildConfig.allowedRoles)` would throw
 *  on undefined for a guild with no config at all). */
export function teamGuildConfigs(teams: Record<string, TeamConfig>): Record<string, GuildConfig> {
  const out: Record<string, GuildConfig> = {};
  for (const team of Object.values(teams)) {
    for (const space of team.spaces) {
      if (space.surface !== "discord" || !space.discord) continue;
      out[space.spaceId] = space.statusChannelId
        ? { ...space.discord, wiki: { ...space.discord.wiki, statusChannelId: space.statusChannelId } }
        : space.discord;
    }
  }
  return out;
}

// Teams load first so its discord blocks are available to derive guildConfig below — config.ts ↔
// teams.ts has a value-import cycle that's only safe because neither side dereferences the other at
// module top level; this stays inside loader functions.
const loadedTeams = loadTeams();
const derivedGuildConfig = teamGuildConfigs(loadedTeams);

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
  guildConfig: derivedGuildConfig,
  principals: loadPrincipals(),
  teams: loadedTeams,
  sushiiMcpUrl: process.env["SUSHII_MCP_URL"],
  sushiiMcpToken: process.env["SUSHII_MCP_TOKEN"],
  mnemosyneMcpUrl: process.env["MNEMOSYNE_MCP_URL"],
  mnemosyneMcpToken: process.env["MNEMOSYNE_MCP_TOKEN"],
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
  orchPort: optionalPort("ORCH_PORT", 8788),
  orchSecret: process.env["ORCH_SECRET"]?.trim() || undefined,
  dmWorkspaceEnabled: ["1", "true", "yes"].includes(optional("DM_WORKSPACE_ENABLED", "false").toLowerCase()),
  workspacePreferredSurface: preferredSurface(),
  ownerDmMode: parseOwnerDmMode(process.env["OWNER_DM_MODE"], preferredSurface()),
  buzz: {
    privateKey: process.env["BUZZ_PRIVATE_KEY"],
    relayUrls: parseRelayUrls(process.env["BUZZ_RELAY_URL"]),
    authTag: process.env["BUZZ_AUTH_TAG"],
    displayName: optional("BUZZ_DISPLAY_NAME", "sushii-agent"),
    avatarUrl: process.env["BUZZ_AVATAR_URL"],
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
  },
};
