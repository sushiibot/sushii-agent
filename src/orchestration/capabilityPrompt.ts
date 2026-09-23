import { buildOpsTriagePromptSection } from "../modules/ops-triage/prompt.ts";
import { getDispatcher } from "./dispatcher.ts";
import { principalsConfigured } from "./principals.ts";

interface RunnerSummary {
  runnerId: string;
  kind: string;
  location: string | null;
  workspaceRoot: string | null;
  capabilities: string[];
  projects: string[];
}

// Built per turn from the live registry so the model knows which runners exist right now and what
// each can do; tool descriptions alone don't make it think of a runner for "browse this for me".
export function renderRunnerSection(runners: RunnerSummary[], opts: { needsConfirmation?: boolean } = {}): string {
  const lines = [
    "## Runners",
    "You can hand work to background agents on runners with dispatch_to_runner, and follow it with list_running_sessions / read_session / steer_task. Use a runner for anything you cannot do inside this chat:",
    "- Code changes: pass `repo` (owner/name) to have it cloned, or `cwd` for a project the runner already has.",
    "- Anything that needs a real web browser, on a runner with the `browser` capability: browsing or searching a site, testing a web app, filling forms, adding items to a cart, reading pages that block plain fetches. Omit repo and cwd and set browser=true.",
    "Never tell the user you can't browse, click, or act on a website while a browser-capable runner is online — dispatch it instead. Web search and fetch tools are still fine for quick lookups. The runner tries its own browser first and only falls back to a paid cloud browser when a site blocks it.",
  ];
  if (opts.needsConfirmation) {
    lines.push("Your dispatches need confirmation: dispatch_to_runner returns a summary instead of starting. Show it, and dispatch only after the user confirms in a new message.");
  }
  if (runners.length === 0) {
    lines.push("", "No runners are online right now, so dispatches will fail until one reconnects.");
    return lines.join("\n");
  }
  lines.push("", "Online now:");
  for (const r of runners) {
    const can = [
      r.capabilities.includes("browser") ? "browser" : null,
      r.workspaceRoot ? "clones repos, scratch tasks" : null,
      r.projects.length ? `projects: ${r.projects.map((p) => p.split("/").pop()).join(", ")}` : null,
    ].filter(Boolean);
    const where = r.location ? `, ${r.location}` : "";
    lines.push(`- ${r.runnerId} (${r.kind}${where}): ${can.length ? can.join("; ") : "coding in its declared directories"}`);
  }
  return lines.join("\n");
}

function buildRunnerSection(needsConfirmation: boolean): string | undefined {
  try {
    const dispatcher = getDispatcher();
    const runners = dispatcher.listRunners().map((r) => ({ ...r, location: dispatcher.runnerInfo(r.runnerId)?.location ?? null }));
    return renderRunnerSection(runners, { needsConfirmation });
  } catch {
    return undefined; // dispatcher unavailable → runner tools are disabled too
  }
}

export interface CapabilityTurn {
  surface: string;
  spaceId: string;
  userId: string;
  isPrivate: boolean;
  isOwner: boolean;
  tools: string[];
}

// One line per capability, listed only when its tools resolved for this turn. The tool descriptions
// carry the how-to; this tells the model the capability exists so it reaches for it.
const CAPABILITY_LINES: { tools: string[]; line: string }[] = [
  { tools: ["web_search", "fetch_url_content"], line: "Search the web and read pages (web_search, fetch_url_content) for anything current or outside your knowledge." },
  { tools: ["search_files", "read_file", "list_files"], line: "This space's knowledge base (search_files, read_file, list_files): check it first for documented background, and cite the link it gives." },
  { tools: ["search_messages", "get_conversation_context", "fetch_channel_messages", "get_recent_activity"], line: "This server's message history and members (search_messages, get_conversation_context, fetch_channel_messages, get_user_profile and related): look things up instead of guessing." },
  { tools: ["inspect_image"], line: "Look at images and attachments (inspect_image)." },
  { tools: ["memory"], line: "Notes that persist for this space (memory): save durable facts and preferences worth keeping; skip one-off details." },
  { tools: ["update_profile"], line: "The user's profile (update_profile): refine it when you learn a lasting fact about them." },
  { tools: ["ask_question"], line: "Ask the user to pick between options (ask_question) when a choice is genuinely theirs." },
];

export function renderCapabilityMap(tools: Set<string>): string | undefined {
  const lines = CAPABILITY_LINES.filter((c) => c.tools.some((name) => tools.has(name))).map((c) => `- ${c.line}`);
  return lines.length ? ["## What you can do here", ...lines].join("\n") : undefined;
}

/** Capability sections for this turn, derived from the tools that actually resolved: the capability
 *  map, ops when its tools are present, runners when dispatch is. */
export function buildCapabilitySections(t: CapabilityTurn): string | undefined {
  const tools = new Set(t.tools);
  const ops = tools.has("search_logs") || tools.has("file_linear_issue") ? buildOpsTriagePromptSection() : undefined;
  // Mirrors the dispatch tool: with a principal registry, only the owner dispatches without confirming.
  const runners = tools.has("dispatch_to_runner") ? buildRunnerSection(principalsConfigured() && !t.isOwner) : undefined;
  const parts = [renderCapabilityMap(tools), ops, runners].filter((s): s is string => !!s);
  return parts.length ? parts.join("\n\n") : undefined;
}
