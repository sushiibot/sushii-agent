// Team concept: an admin-declared grouping of one team's spaces (a Discord guild, a Slack
// team, a buzz relay) plus its per-team scoping (its own Linear account, its wiki reference),
// hand-maintained in teams.json (path via TEAMS_PATH, mirroring PRINCIPALS_PATH). The
// file IS the source of truth — no discovery. Resolves (surface, spaceId) → team for
// per-scope ops-triage (Linear) routing.
//
// HARD WALL: this module MUST NOT be reachable from the memory-scope path (banks.ts / agentCore's
// memoryScope). A team groups multiple surfaces; if a memory spaceId resolved through it,
// `sushii-space-<spaceId>` would merge public facts across Discord/Slack/buzz memberships.
import type { GuildConfig, ModuleId } from "../guildConfig.ts";
import { config } from "../config.ts";
import { normalizeRelayUrl } from "../surfaces/buzz/relayUrl.ts";

export interface TeamSpace {
  surface: string;
  spaceId: string;
  /** This space's role in the team's wiki (`team.wiki.wikiId`): "source" feeds and reads it,
   *  "read" only reads it. Absent → this space has no wiki. */
  wiki?: "source" | "read";
  /** This space's own wiki-sync status channel. */
  statusChannelId?: string;
  /** Inline Discord guild config, only on a `surface: "discord"` space. Folded into
   *  `config.guildConfig` at load (config.ts's teamGuildConfigs) — its own `wiki.statusChannelId`
   *  is rejected at parse since the space-level `statusChannelId` above is the one wiki-sync uses. */
  discord?: GuildConfig;
  /** Inline buzz relay settings, only on a `surface: "buzz"` space. */
  buzz?: { avatarUrl?: string };
}

/** Vetted people beyond the owner. `trusted: true` = the elevated set (same tools the owner gets),
 *  scoped to this team's spaces. Deliberately flat — no per-capability granularity. */
export type TeamMembers = Record<string, { trusted?: boolean }>;

/** A team's Linear account. `apiKeyEnv` names the env var read at resolve time (linear.ts). */
export interface TeamLinear {
  teamId: string;
  apiKeyEnv?: string;
}

/** Raw per-team entry as it appears in teams.json (keyed by team id). */
export interface TeamConfig {
  spaces: TeamSpace[];
  /** Reference to an existing wiki (wikiId == guildId). Does NOT drive wiki-sync source derivation. */
  wiki?: { wikiId: string };
  /** This team's own Linear account. Absent → ops-triage falls through to the default (SUSHI). */
  linear?: TeamLinear;
  /** Authorized principals in this team, keyed by principalId. */
  members?: TeamMembers;
  /** Extends trust (same as a `members[...].trusted` principal) to anyone posting from this team's
   *  non-Discord spaces, gated per space in the entry gate rather than parsed here. */
  trustSpaceMembers?: boolean;
}

export interface Team {
  id: string;
  spaces: TeamSpace[];
  wiki?: { wikiId: string };
  linear?: TeamLinear;
  members?: TeamMembers;
  trustSpaceMembers?: boolean;
}

interface TeamIndex {
  bySpace: Map<string, Team>;
}

function keyOf(surface: string, spaceId: string): string {
  return `${surface} ${spaceId}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

const MODULE_IDS: ModuleId[] = ["moderation", "mcp", "ops-triage"];

/** Validate + narrow a space's inline `discord` block to the `GuildConfig` shape. Rejects
 *  `wiki.statusChannelId` — that field belongs on the space itself (see TeamSpace.statusChannelId)
 *  so wiki-sync has one place to look, not two that could disagree. */
function parseDiscordBlock(id: string, i: number, raw: unknown): GuildConfig {
  const prefix = `teams: "${id}".spaces[${i}].discord`;
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be an object`);
  if (!isStringArray(raw["allowedRoles"])) throw new Error(`${prefix}.allowedRoles must be a string array`);

  const stringArrayFields = ["emojis", "modImmuneRoleIds", "autoModTriggerRoleIds", "mcpBridgeAllowedUserIds"] as const;
  for (const field of stringArrayFields) {
    if (raw[field] !== undefined && !isStringArray(raw[field])) throw new Error(`${prefix}.${field} must be a string array`);
  }
  const stringFields = ["modRoleId", "alertsChannelId"] as const;
  for (const field of stringFields) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`${prefix}.${field} must be a string`);
  }
  const numberFields = ["newMemberThresholdDays", "autoModCooldownSeconds"] as const;
  for (const field of numberFields) {
    if (raw[field] !== undefined && typeof raw[field] !== "number") throw new Error(`${prefix}.${field} must be a number`);
  }
  if (raw["autoModDryRun"] !== undefined && typeof raw["autoModDryRun"] !== "boolean") {
    throw new Error(`${prefix}.autoModDryRun must be a boolean`);
  }
  const promptTemplate = raw["promptTemplate"];
  if (promptTemplate !== undefined && promptTemplate !== "moderation" && promptTemplate !== "general") {
    throw new Error(`${prefix}.promptTemplate must be "moderation" or "general"`);
  }
  const enabledModules = raw["enabledModules"];
  if (enabledModules !== undefined) {
    if (!Array.isArray(enabledModules)) throw new Error(`${prefix}.enabledModules must be an array drawn from ${MODULE_IDS.join(", ")}`);
    if (enabledModules.includes("wiki-sync")) {
      throw new Error(`${prefix}.enabledModules must not include "wiki-sync" — wiki participation is set via the space's own \`wiki\` role, not a module`);
    }
    if (!enabledModules.every((m) => MODULE_IDS.includes(m as ModuleId))) {
      throw new Error(`${prefix}.enabledModules must be an array drawn from ${MODULE_IDS.join(", ")}`);
    }
  }
  const wiki = raw["wiki"];
  if (wiki !== undefined) {
    if (!isPlainObject(wiki)) throw new Error(`${prefix}.wiki must be an object`);
    if (wiki["statusChannelId"] !== undefined) {
      throw new Error(`${prefix}.wiki.statusChannelId is not allowed — use the space-level statusChannelId field instead`);
    }
  }

  return {
    allowedRoles: raw["allowedRoles"] as string[],
    emojis: raw["emojis"] as string[] | undefined,
    modRoleId: raw["modRoleId"] as string | undefined,
    alertsChannelId: raw["alertsChannelId"] as string | undefined,
    modImmuneRoleIds: raw["modImmuneRoleIds"] as string[] | undefined,
    newMemberThresholdDays: raw["newMemberThresholdDays"] as number | undefined,
    autoModDryRun: raw["autoModDryRun"] as boolean | undefined,
    autoModTriggerRoleIds: raw["autoModTriggerRoleIds"] as string[] | undefined,
    autoModCooldownSeconds: raw["autoModCooldownSeconds"] as number | undefined,
    mcpBridgeAllowedUserIds: raw["mcpBridgeAllowedUserIds"] as string[] | undefined,
    promptTemplate: promptTemplate as GuildConfig["promptTemplate"],
    enabledModules: enabledModules as ModuleId[] | undefined,
  };
}

/** Validate + narrow a space's inline `buzz` block. */
function parseBuzzBlock(id: string, i: number, raw: unknown): { avatarUrl?: string } {
  const prefix = `teams: "${id}".spaces[${i}].buzz`;
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be an object`);
  const avatarUrl = raw["avatarUrl"];
  if (avatarUrl !== undefined && !isNonEmptyString(avatarUrl)) throw new Error(`${prefix}.avatarUrl must be a string`);
  return { avatarUrl };
}

function normalizeSpaceId(surface: string, spaceId: string): string {
  return surface === "buzz" && spaceId.startsWith("buzz:")
    ? `buzz:${normalizeRelayUrl(spaceId.slice("buzz:".length))}`
    : spaceId;
}

function parseLinear(id: string, linearRaw: unknown): TeamLinear | undefined {
  if (linearRaw === undefined) return undefined;
  if (!isPlainObject(linearRaw) || !isNonEmptyString(linearRaw["teamId"])) {
    throw new Error(`teams: "${id}".linear must be {teamId: string, apiKeyEnv?: string}`);
  }
  if (linearRaw["apiKey"] !== undefined) {
    throw new Error(`teams: "${id}".linear.apiKey is not allowed — use linear.apiKeyEnv instead`);
  }
  const apiKeyEnvRaw = linearRaw["apiKeyEnv"];
  if (apiKeyEnvRaw !== undefined && !isNonEmptyString(apiKeyEnvRaw)) {
    throw new Error(`teams: "${id}".linear.apiKeyEnv must be a string`);
  }
  return { teamId: linearRaw["teamId"], apiKeyEnv: apiKeyEnvRaw };
}

/** Validate + normalize the raw teams.json shape, called at config load. Buzz spaceIds are
 *  normalized the same way as the relay poll loop's cursor key, so `buzz:wss://Relay.Example/` and
 *  `buzz:https://relay.example` collide as the same space instead of silently splitting one
 *  team's config across two keys. Throws `Error("teams: <reason>")` on any shape violation. */
export function parseTeams(raw: unknown): Record<string, TeamConfig> {
  if (!isPlainObject(raw)) throw new Error("teams: top-level value must be an object");

  const out: Record<string, TeamConfig> = {};
  for (const [id, entryRaw] of Object.entries(raw)) {
    if (!isPlainObject(entryRaw)) throw new Error(`teams: entry "${id}" must be an object`);

    const spacesRaw = entryRaw["spaces"];
    if (!Array.isArray(spacesRaw)) throw new Error(`teams: "${id}".spaces must be an array`);
    const spaces: TeamSpace[] = spacesRaw.map((s, i) => {
      if (!isPlainObject(s) || !isNonEmptyString(s["surface"]) || !isNonEmptyString(s["spaceId"])) {
        throw new Error(`teams: "${id}".spaces[${i}] must be {surface: string, spaceId: string}`);
      }
      const wikiRaw = s["wiki"];
      if (wikiRaw !== undefined && wikiRaw !== "source" && wikiRaw !== "read") {
        throw new Error(`teams: "${id}".spaces[${i}].wiki must be "source" or "read"`);
      }
      const statusChannelIdRaw = s["statusChannelId"];
      if (statusChannelIdRaw !== undefined && !isNonEmptyString(statusChannelIdRaw)) {
        throw new Error(`teams: "${id}".spaces[${i}].statusChannelId must be a string`);
      }
      const discordRaw = s["discord"];
      if (discordRaw !== undefined && s["surface"] !== "discord") {
        throw new Error(`teams: "${id}".spaces[${i}].discord is only allowed on a "discord" surface space`);
      }
      const buzzRaw = s["buzz"];
      if (buzzRaw !== undefined && s["surface"] !== "buzz") {
        throw new Error(`teams: "${id}".spaces[${i}].buzz is only allowed on a "buzz" surface space`);
      }
      return {
        surface: s["surface"],
        spaceId: normalizeSpaceId(s["surface"], s["spaceId"]),
        wiki: wikiRaw as TeamSpace["wiki"],
        statusChannelId: statusChannelIdRaw,
        discord: discordRaw !== undefined ? parseDiscordBlock(id, i, discordRaw) : undefined,
        buzz: buzzRaw !== undefined ? parseBuzzBlock(id, i, buzzRaw) : undefined,
      };
    });

    const membersRaw = entryRaw["members"];
    let members: TeamMembers | undefined;
    if (membersRaw !== undefined) {
      if (!isPlainObject(membersRaw)) throw new Error(`teams: "${id}".members must be an object`);
      for (const [principalId, m] of Object.entries(membersRaw)) {
        if (!isPlainObject(m)) throw new Error(`teams: "${id}".members["${principalId}"] must be an object`);
        if (m["trusted"] !== undefined && typeof m["trusted"] !== "boolean") {
          throw new Error(`teams: "${id}".members["${principalId}"].trusted must be a boolean`);
        }
      }
      members = membersRaw as TeamMembers;
    }

    const trustSpaceMembersRaw = entryRaw["trustSpaceMembers"];
    if (trustSpaceMembersRaw !== undefined && typeof trustSpaceMembersRaw !== "boolean") {
      throw new Error(`teams: "${id}".trustSpaceMembers must be a boolean`);
    }

    out[id] = {
      spaces,
      wiki: entryRaw["wiki"] as TeamConfig["wiki"],
      linear: parseLinear(id, entryRaw["linear"]),
      members,
      trustSpaceMembers: trustSpaceMembersRaw as boolean | undefined,
    };
  }
  return out;
}

/** Narrows a raw teams.json entry into a `Team`, filling every field a `Team` carries — the single
 *  place all three lookup paths (index, listTeams, getTeam) build one, so adding a field can't be
 *  missed in one of them. */
function toTeam(id: string, entry: TeamConfig | undefined): Team {
  return {
    id,
    spaces: entry?.spaces ?? [],
    wiki: entry?.wiki,
    linear: entry?.linear,
    members: entry?.members,
    trustSpaceMembers: entry?.trustSpaceMembers,
  };
}

/** Build the reverse (surface, spaceId) → team index, enforcing that no space is claimed by two
 *  teams. Throws on a duplicate — surfaced at config load (config.ts) and on the lazy rebuild. */
export function buildTeamIndex(teams: Record<string, TeamConfig>): TeamIndex {
  const bySpace = new Map<string, Team>();
  for (const [id, entry] of Object.entries(teams)) {
    const team = toTeam(id, entry);
    for (const s of team.spaces) {
      const k = keyOf(s.surface, s.spaceId);
      const existing = bySpace.get(k);
      if (existing) {
        throw new Error(`teams: space ${s.surface}/${s.spaceId} is claimed by both "${existing.id}" and "${id}"`);
      }
      bySpace.set(k, team);
    }
  }
  return { bySpace };
}

// Reference-identity cache: rebuilt only when `config.teams` is REASSIGNED (never mutate the
// map in place — an in-place edit leaves this index stale). Lazy so config load order is irrelevant
// and tests can swap the whole map between cases. Same pattern as principals.ts.
let cache: { source: Record<string, TeamConfig>; index: TeamIndex } | null = null;

function index(): TeamIndex {
  if (!cache || cache.source !== config.teams) {
    cache = { source: config.teams, index: buildTeamIndex(config.teams) };
  }
  return cache.index;
}

/** Resolve (surface, spaceId) → its team, or undefined when the space belongs to none. */
export function resolveTeam(surface: string, spaceId: string): Team | undefined {
  if (spaceId.length === 0) return undefined;
  return index().bySpace.get(keyOf(surface, spaceId));
}

/** Whether `principalId` is a trusted member of the team that owns (surface, spaceId). Pure;
 *  false when the space belongs to no team or the principal isn't listed as trusted there. */
export function isTeamMember(principalId: string, surface: string, spaceId: string): boolean {
  return resolveTeam(surface, spaceId)?.members?.[principalId]?.trusted === true;
}

/** Buzz kind:0 profile avatar for a relay space: a team space's inline `buzz.avatarUrl` first, then
 *  the global `BUZZ_AVATAR_URL` fallback. */
export function buzzAvatarFor(spaceId: string): string | undefined {
  const teamAvatar = resolveTeam("buzz", spaceId)?.spaces.find((s) => s.surface === "buzz" && s.spaceId === spaceId)?.buzz?.avatarUrl;
  return teamAvatar ?? config.buzz.avatarUrl;
}

/** All teams, by id — for a DM listing where there's no (surface, spaceId) to resolve from. */
export function listTeams(): Team[] {
  return Object.entries(config.teams).map(([id, entry]) => toTeam(id, entry));
}

/** A team by its own id, independent of any space — for a DM's `team` lookup. */
export function getTeam(teamId: string): Team | undefined {
  const entry = Object.hasOwn(config.teams, teamId) ? config.teams[teamId] : undefined;
  return entry ? toTeam(teamId, entry) : undefined;
}
