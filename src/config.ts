export { type GuildConfig, getPermittedGuildIds, buildEmojiMap, resolvedModules } from "./guildConfig.ts";
import type { GuildConfig } from "./guildConfig.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";
import type { TeamConfig } from "./orchestration/teams.ts";
import { parseTeams, buildTeamIndex } from "./orchestration/teams.ts";
import { parseRelayUrls, parseWikiMap, parseAvatarMap } from "./surfaces/buzz/relayUrl.ts";
import { getLogger } from "./logger.ts";

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
  guildConfig: Record<string, GuildConfig>;
  /** Manual cross-platform identity registry (principal → identities), hand-maintained in
   *  principals.json (path via PRINCIPALS_PATH). Missing/empty file + OWNER_DISCORD_ID set →
   *  a single owner principal is synthesized from it. Neither set → empty map, nobody is owner
   *  (default deny). See loadPrincipals below and orchestration/principals.ts. */
  principals: Record<string, PrincipalConfig>;
  /** Team grouping (team id → its spaces + per-team scoping), hand-maintained in teams.json
   *  (path via TEAMS_PATH, falling back to the legacy COMMUNITIES_PATH). Empty/unset →
   *  unconfigured; ops-triage Linear routing falls through to the global default. See
   *  orchestration/teams.ts. */
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
  for (const [id, entry] of Object.entries(teams)) {
    if (entry.linear?.apiKey) {
      logger.warn({ teamId: id }, "teams.json linear.apiKey is a literal key — deprecated, use linear.apiKeyEnv instead");
    }
  }
  return teams;
}

/** Load + validate the team grouping. Explicit-before-default: TEAMS_PATH set → it wins outright; else
 *  COMMUNITIES_PATH set → it wins outright (deprecation warn); either one failing to read/parse throws,
 *  since an explicit path is a promise the file is there. Only when NEITHER env var is set does the
 *  default-path guess kick in: ./teams.json if present, else ./communities.json if present (deprecation
 *  warn), else "unconfigured" (empty). An explicit env var must never be shadowed by a default-path
 *  guess — that was the bug: trying "./teams.json" first regardless of which env var was set let a
 *  checked-in repo-root stub silently outrank a real COMMUNITIES_PATH. Setting BOTH env vars is a
 *  misconfiguration and throws immediately, before either file is touched. `readFile` is injectable so
 *  this is testable without real files (mirrors resolveOwnerPrincipals's injectable `warn`). Shape
 *  validation and buzz spaceId normalization live in parseTeams (teams.ts); buildTeamIndex then runs on
 *  the normalized output so two spellings of one relay collide as a duplicate at boot, not later. */
export function resolveTeamsConfig(
  teamsPathEnv: string | undefined,
  communitiesPathEnv: string | undefined,
  readFile: (filePath: string) => string,
  warn: (ctx: Record<string, unknown>, msg: string) => void = (ctx, msg) => logger.warn(ctx, msg),
): Record<string, TeamConfig> {
  if (teamsPathEnv && communitiesPathEnv) {
    throw new Error("Set only one of TEAMS_PATH or COMMUNITIES_PATH, not both");
  }

  if (teamsPathEnv) {
    let content: string;
    try {
      content = readFile(teamsPathEnv);
    } catch (e) {
      throw new Error(`Failed to load teams from ${teamsPathEnv}: ${e}`);
    }
    return parseTeamsJson(content, teamsPathEnv);
  }

  const legacyWarn = (filePath: string) =>
    warn({ filePath }, "loading teams from a legacy communities.json path — rename it to teams.json (or set TEAMS_PATH)");

  if (communitiesPathEnv) {
    let content: string;
    try {
      content = readFile(communitiesPathEnv);
    } catch (e) {
      throw new Error(`Failed to load teams from ${communitiesPathEnv}: ${e}`);
    }
    legacyWarn(communitiesPathEnv);
    return parseTeamsJson(content, communitiesPathEnv);
  }

  try {
    const content = readFile("./teams.json");
    return parseTeamsJson(content, "./teams.json");
  } catch {
    // No default teams.json — fall through to the legacy default path below.
  }

  try {
    const content = readFile("./communities.json");
    legacyWarn("./communities.json");
    return parseTeamsJson(content, "./communities.json");
  } catch {
    return {};
  }
}

function loadTeams(): Record<string, TeamConfig> {
  return resolveTeamsConfig(process.env["TEAMS_PATH"], process.env["COMMUNITIES_PATH"], (p) => readFileSync(p, "utf8"));
}

/** Fields whose value is used as a set (`.includes()`/`hasAny()`), never as an ordered list, so two
 *  listings of the same ids in a different order are equivalent, not a conflict. */
const SET_LIKE_FIELDS = new Set([
  "allowedRoles",
  "emojis",
  "modImmuneRoleIds",
  "autoModTriggerRoleIds",
  "mcpBridgeAllowedUserIds",
  "enabledModules",
]);

/** Sort object keys (recursively) so two objects with the same keys in a different order compare
 *  equal under JSON.stringify. Leaves arrays' element order untouched — that's SET_LIKE_FIELDS'
 *  job, one level up in fieldsEqual. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Field-aware equality for the conflict check below: a SET_LIKE_FIELDS array compares as a set
 *  (order-insensitive); everything else compares structurally with object keys order-insensitive. */
function fieldsEqual(key: string, a: unknown, b: unknown): boolean {
  if (SET_LIKE_FIELDS.has(key) && Array.isArray(a) && Array.isArray(b)) {
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return JSON.stringify(sortedA) === JSON.stringify(sortedB);
  }
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Discord guild configs carried inline on team spaces (space.discord), keyed by guild id, exactly
 *  as parsed — the space-level statusChannelId is applied later, as an override onto the merged
 *  result (see applyStatusChannelOverrides), not folded in here. */
export function teamGuildConfigs(teams: Record<string, TeamConfig>): Record<string, GuildConfig> {
  const out: Record<string, GuildConfig> = {};
  for (const team of Object.values(teams)) {
    for (const space of team.spaces) {
      if (space.surface !== "discord" || !space.discord) continue;
      out[space.spaceId] = space.discord;
    }
  }
  return out;
}

/** Every discord team space's own statusChannelId, keyed by guild id — the input to
 *  applyStatusChannelOverrides. A space without one is omitted. */
export function teamStatusChannelIds(teams: Record<string, TeamConfig>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const team of Object.values(teams)) {
    for (const space of team.spaces) {
      if (space.surface === "discord" && space.statusChannelId) {
        out[space.spaceId] = space.statusChannelId;
      }
    }
  }
  return out;
}

/** Merge guild-config.json with team-derived discord blocks (teamGuildConfigs). A guild id present
 *  in only one side passes through untouched. A guild id present in both, with some field set to
 *  different values on each side, throws — naming the guild and the conflicting field(s) — since
 *  there'd be no principled way to pick a winner. A guild id present in both with no such conflict
 *  merges (team-side fields fill in gaps) and logs one warn suggesting the guild-config.json entry
 *  be removed now that the team carries it. `wiki` is excluded from this check entirely: it has its
 *  own dedicated precedence rule (applyStatusChannelOverrides), not a plain must-match-or-throw field. */
export function mergeGuildConfigs(
  fileConfig: Record<string, GuildConfig>,
  teamConfig: Record<string, GuildConfig>,
  warn: (ctx: Record<string, unknown>, msg: string) => void = (ctx, msg) => logger.warn(ctx, msg),
): Record<string, GuildConfig> {
  const merged: Record<string, GuildConfig> = { ...fileConfig };
  for (const [guildId, teamCfg] of Object.entries(teamConfig)) {
    const fileCfg = fileConfig[guildId];
    if (!fileCfg) {
      merged[guildId] = teamCfg;
      continue;
    }
    const combined = { ...fileCfg } as unknown as Record<string, unknown>;
    const conflicts: string[] = [];
    for (const [key, value] of Object.entries(teamCfg as unknown as Record<string, unknown>)) {
      if (key === "wiki" || value === undefined) continue;
      const existing = (fileCfg as unknown as Record<string, unknown>)[key];
      if (existing === undefined) {
        combined[key] = value;
      } else if (!fieldsEqual(key, existing, value)) {
        conflicts.push(key);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `guild config conflict for guild ${guildId}: field(s) ${conflicts.join(", ")} differ between guild-config.json and a team's discord block`,
      );
    }
    merged[guildId] = combined as unknown as GuildConfig;
    warn({ guildId }, "guild is configured in both guild-config.json and a team's discord block — consider removing it from guild-config.json");
  }
  return merged;
}

/** Apply each team discord space's own statusChannelId as an unconditional override onto
 *  merged[spaceId].wiki.statusChannelId — never synthesizing a brand-new merged[spaceId] entry out
 *  of just a statusChannelId with no allowedRoles (resolvedModules() defaulting to ["moderation"]
 *  and command.ts's hasAny(...guildConfig.allowedRoles) would throw on undefined for a guild that
 *  otherwise has no config at all). A guild-config.json entry that also sets a different
 *  wiki.statusChannelId warns once (the team value wins, it isn't a conflict). */
export function applyStatusChannelOverrides(
  merged: Record<string, GuildConfig>,
  statusChannelIds: Record<string, string>,
  warn: (ctx: Record<string, unknown>, msg: string) => void = (ctx, msg) => logger.warn(ctx, msg),
): Record<string, GuildConfig> {
  const out: Record<string, GuildConfig> = { ...merged };
  for (const [guildId, statusChannelId] of Object.entries(statusChannelIds)) {
    const existing = out[guildId];
    if (!existing) continue;
    const fileStatusChannelId = existing.wiki?.statusChannelId;
    if (fileStatusChannelId !== undefined && fileStatusChannelId !== statusChannelId) {
      warn(
        { guildId, fileStatusChannelId, teamStatusChannelId: statusChannelId },
        "guild-config.json's wiki.statusChannelId differs from the team space's statusChannelId — the team space's value wins",
      );
    }
    out[guildId] = { ...existing, wiki: { ...existing.wiki, statusChannelId } };
  }
  return out;
}

// Teams load first so any inline discord block is available to fold into guildConfig below —
// config.ts ↔ teams.ts has a value-import cycle that's only safe because neither side dereferences
// the other at module top level; this stays inside loader functions.
const loadedTeams = loadTeams();
const mergedGuildConfig = applyStatusChannelOverrides(
  mergeGuildConfigs(loadGuildConfig(), teamGuildConfigs(loadedTeams)),
  teamStatusChannelIds(loadedTeams),
);

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
  guildConfig: mergedGuildConfig,
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
