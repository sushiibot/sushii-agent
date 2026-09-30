import { buildOpsTriagePromptSection } from "../modules/ops-triage/prompt.ts";
import { resolveTeam } from "./teams.ts";
import { wikiFor } from "../modules/wiki-sync/sources.ts";

export interface CapabilityTurn {
  surface: string;
  spaceId: string;
  userId: string;
  isPrivate: boolean;
  isOwner: boolean;
  /** Owner OR a trusted member of this space's team. */
  authorized: boolean;
  tools: string[];
}

const SURFACE_KIND_LABELS: Record<string, string> = {
  discord: "Discord guild",
  slack: "Slack workspace",
  buzz: "buzz relay",
};

/** "## Team" section for a space that belongs to a team: what the other spaces are (kinds,
 *  never raw ids), whether this space can read the team wiki, and the caller's standing. Undefined outside a
 *  team. Text is stable per space (no timestamps, no member ids) so the prefix stays cacheable. */
function buildTeamSection(t: CapabilityTurn): string | undefined {
  const team = resolveTeam(t.surface, t.spaceId);
  if (!team) return undefined;

  const kinds = [...new Set(team.spaces.map((s) => SURFACE_KIND_LABELS[s.surface] ?? s.surface))];
  const standing = t.isOwner ? "the owner" : t.authorized ? "a trusted member" : "a member";

  const lines = [
    "## Team",
    `This space is part of the team "${team.id}", spanning ${kinds.join(", ")}.`,
    `You are speaking with ${standing} of this team.`,
  ];
  if (wikiFor(t.surface, t.spaceId)?.reads) lines.push("This space can read the team's shared wiki.");
  return lines.join("\n");
}

// One line per capability, listed only when its tools resolved for this turn. The tool descriptions
// carry the how-to; this tells the model the capability exists so it reaches for it.
const CAPABILITY_LINES: { tools: string[]; line: string }[] = [
  { tools: ["web_search", "fetch_url_content"], line: "Search the web and read pages (web_search, fetch_url_content) for anything current or outside your knowledge." },
  { tools: ["search_files", "read_file", "list_files"], line: "Your team's shared knowledge base (wiki) (search_files, read_file, list_files): check it first for documented background, and cite the link it gives." },
  { tools: ["search_messages", "get_conversation_context", "fetch_channel_messages", "get_recent_activity"], line: "This server's message history and members (search_messages, get_conversation_context, fetch_channel_messages, get_user_profile and related): look things up instead of guessing." },
  { tools: ["inspect_image"], line: "Look at images and attachments (inspect_image)." },
  { tools: ["memory"], line: "Notes that persist for this space (memory): save durable facts and preferences worth keeping; skip one-off details." },
  { tools: ["update_profile"], line: "The user's profile (update_profile): refine it when you learn a lasting fact about them." },
  { tools: ["ask_question"], line: "Ask the user to pick between options (ask_question) when a choice is genuinely theirs." },
  { tools: ["team_config"], line: "Your team's configuration across its Discord/Slack/buzz spaces (team_config) — check it before answering questions about setup, personas, modules, or who can do what." },
];

export function renderCapabilityMap(tools: Set<string>): string | undefined {
  const lines = CAPABILITY_LINES.filter((c) => c.tools.some((name) => tools.has(name))).map((c) => `- ${c.line}`);
  return lines.length ? ["## What you can do here", ...lines].join("\n") : undefined;
}

/** Capability sections for this turn, derived from the tools that actually resolved: the capability
 *  map, the team, and ops when its tools are present. */
export function buildCapabilitySections(t: CapabilityTurn): string | undefined {
  const tools = new Set(t.tools);
  const ops = tools.has("search_logs") || tools.has("file_linear_issue") ? buildOpsTriagePromptSection() : undefined;
  const team = buildTeamSection(t);
  const parts = [renderCapabilityMap(tools), team, ops].filter((s): s is string => !!s);
  return parts.length ? parts.join("\n\n") : undefined;
}
