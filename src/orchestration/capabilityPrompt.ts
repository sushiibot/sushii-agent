import { config } from "../config.ts";
import { buildOpsTriagePromptSection } from "../modules/ops-triage/prompt.ts";
import { can, spaceKey } from "./authz.ts";
import { getDispatcher } from "./dispatcher.ts";
import { principalsConfigured, resolvePrincipal } from "./principals.ts";

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
}

// Same owner test as the ops tools: the registry's owner principal, else the legacy Discord owner id.
function isOwner(t: CapabilityTurn): boolean {
  if (principalsConfigured()) return resolvePrincipal(t.surface, t.userId)?.isOwner ?? false;
  return t.surface === "discord" && !!config.ownerDiscordId && t.userId === config.ownerDiscordId;
}

/** Capability sections for this turn's initiator, gated exactly like the tools they describe: ops
 *  for the owner, runners for anyone authorized to dispatch in this space. */
export function buildCapabilitySections(t: CapabilityTurn): string | undefined {
  const owner = isOwner(t);
  const canDispatch = can({ principal: t.userId, capability: "runner.dispatch", space: spaceKey(t.surface, t.spaceId), isPrivate: t.isPrivate });
  const parts = [owner ? buildOpsTriagePromptSection() : undefined, canDispatch ? buildRunnerSection(!owner) : undefined];
  const present = parts.filter((s): s is string => !!s);
  return present.length ? present.join("\n\n") : undefined;
}
