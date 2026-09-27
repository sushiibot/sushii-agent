// Read-only view of a team's configuration (teams.ts): one config owner spanning its Discord
// guild, Slack workspace and buzz relays, all defined in teams.json. This only gathers them per
// space so a team can see what applies to it.
import { config } from "../config.ts";
import { resolvedModules } from "../guildConfig.ts";
import { wikiFor } from "../modules/wiki-sync/sources.ts";
import { ownerPrincipalId } from "./principals.ts";
import { buzzAvatarFor, getTeam, resolveTeam, type Team, type TeamSpace } from "./teams.ts";

export interface SpaceConfigView {
  surface: string;
  spaceId: string;
  settings: [label: string, value: string][];
}

export interface TeamConfigView {
  team?: { id: string; owner?: string; trustedMembers: string[]; linear: string; wiki?: string; trustSpaceMembers: boolean };
  spaces: SpaceConfigView[];
}

/** Per-space aggregate counts only, never memory content — the tool builds this from
 *  ctx.memory.count/getServerContext so a count can't leak what a space actually stored. */
export type SpaceStats = (spaceId: string) => { memoryEntries: number; contextChars: number };

function list(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "(none)";
}

function surfaceSettings(surface: string, spaceId: string, detailed: boolean): [string, string][] {
  if (surface === "discord") {
    const cfg = config.guildConfig[spaceId];
    if (!cfg) return [["guild config", "(none — no discord block for this space in teams.json)"]];
    const out: [string, string][] = [
      ["persona", cfg.promptTemplate ?? "moderation"],
      ["modules", resolvedModules(cfg).join(", ")],
      ["allowed roles", list(cfg.allowedRoles)],
      ["emojis", cfg.emojis?.length ? `${cfg.emojis.length} configured` : "(none)"],
    ];
    if (cfg.modRoleId) {
      if (detailed) {
        out.push(
          ["auto-mod", `mod role ${cfg.modRoleId}, alerts channel ${cfg.alertsChannelId ?? "(unset)"}${cfg.autoModDryRun ? ", dry run" : ""}`],
          ["auto-mod immune roles", list(cfg.modImmuneRoleIds)],
          ["auto-mod trigger roles", cfg.autoModTriggerRoleIds?.length ? cfg.autoModTriggerRoleIds.join(", ") : "(anyone)"],
          ["new member threshold", `${cfg.newMemberThresholdDays ?? 3} days`],
          ["auto-mod cooldown", `${cfg.autoModCooldownSeconds ?? 60}s`],
        );
      } else {
        out.push(["auto-mod", "configured (details only in a DM)"]);
      }
    }
    if (detailed && cfg.mcpBridgeAllowedUserIds?.length) out.push(["MCP bridge users", cfg.mcpBridgeAllowedUserIds.join(", ")]);
    if (cfg.wiki?.statusChannelId) out.push(["wiki status channel", cfg.wiki.statusChannelId]);
    return out;
  }
  if (surface === "buzz") {
    return [
      ["persona", "buzz"],
      ["avatar", buzzAvatarFor(spaceId) ?? "(none)"],
    ];
  }
  if (surface === "slack") return [["persona", "slack"]];
  return [];
}

function spaceView(space: TeamSpace, stats: SpaceStats, detailed: boolean): SpaceConfigView {
  const { memoryEntries, contextChars } = stats(space.spaceId);
  const wiki = wikiFor(space.surface, space.spaceId);
  return {
    surface: space.surface,
    spaceId: space.spaceId,
    settings: [
      ...surfaceSettings(space.surface, space.spaceId, detailed),
      ["feeds wiki", wiki?.feeds ? wiki.wikiId : "(none)"],
      ["reads wiki", wiki?.reads ? wiki.wikiId : "(none)"],
      ["server context", contextChars > 0 ? `${contextChars} chars` : "(not scanned)"],
      ["memory entries", String(memoryEntries)],
    ],
  };
}

function buildTeamView(team: Team, stats: SpaceStats, detailed: boolean): TeamConfigView {
  const owner = ownerPrincipalId();
  return {
    team: {
      id: team.id,
      owner,
      trustedMembers: Object.entries(team.members ?? {})
        .filter(([id, m]) => m.trusted && id !== owner)
        .map(([id]) => id),
      linear: team.linear ? `team ${team.linear.teamId}` : "(default)",
      wiki: team.wiki?.wikiId,
      trustSpaceMembers: team.trustSpaceMembers === true,
    },
    spaces: team.spaces.map((s) => spaceView(s, stats, detailed)),
  };
}

/** The config of the team owning (surface, spaceId), or of that space alone when it has no team.
 *  Never includes secrets: a Linear account shows only its team id. `detailed` gates auto-mod
 *  internals and MCP bridge user ids — false outside a private context, since an authorized caller
 *  may run this in a public channel where posting mod-evasion details to moderated users is unsafe. */
export function resolveTeamConfig(surface: string, spaceId: string, stats: SpaceStats, detailed = false): TeamConfigView {
  const team = resolveTeam(surface, spaceId);
  if (!team) return { spaces: [spaceView({ surface, spaceId }, stats, detailed)] };
  return buildTeamView(team, stats, detailed);
}

/** The DM counterpart of resolveTeamConfig: looks a team up by id instead of by space, since a DM
 *  has no space to resolve from. Returns undefined for an unknown id — the caller renders that the
 *  same way as "not a member", so a probing caller can't distinguish the two. */
export function resolveTeamConfigById(teamId: string, stats: SpaceStats, detailed: boolean): TeamConfigView | undefined {
  const team = getTeam(teamId);
  return team ? buildTeamView(team, stats, detailed) : undefined;
}

/** The DM listing view: just the ids of the teams the caller may see (owner → all; otherwise the
 *  ones they're a trusted member of). No settings — call again with `team` for detail. */
export function renderTeamList(teamIds: string[]): string {
  if (teamIds.length === 0) return "You aren't the owner or a trusted member of any team.";
  return [
    "Teams you can view:",
    ...teamIds.map((id) => `- ${id}`),
    "",
    'Call team_config again with `team: "<id>"` to see one team\'s detail.',
  ].join("\n");
}

export function renderTeamConfig(view: TeamConfigView, current: { surface: string; spaceId: string }): string {
  const lines: string[] = [];
  if (view.team) {
    lines.push(`Team: ${view.team.id}`);
    if (view.team.owner) lines.push(`- owner: ${view.team.owner}`);
    lines.push(`- trusted members (besides owner): ${list(view.team.trustedMembers)}`);
    lines.push(`- linear: ${view.team.linear}`);
    if (view.team.wiki) lines.push(`- wiki: ${view.team.wiki}`);
    lines.push(`- trust space members (slack/buzz): ${view.team.trustSpaceMembers ? "yes" : "no"}`);
  } else {
    lines.push("This space is not part of a team (no teams.json entry).");
  }
  for (const s of view.spaces) {
    const here = s.surface === current.surface && s.spaceId === current.spaceId ? " (this space)" : "";
    lines.push("", `${s.surface} ${s.spaceId}${here}`);
    for (const [label, value] of s.settings) lines.push(`- ${label}: ${value}`);
  }
  return lines.join("\n");
}
