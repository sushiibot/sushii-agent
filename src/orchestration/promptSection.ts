import { buildOpsTriagePromptSection } from "../modules/ops-triage/prompt.ts";
import { getDispatcher } from "./dispatcher.ts";

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
export function renderRunnerSection(runners: RunnerSummary[]): string {
  const lines = [
    "## Runners (owner-only)",
    "You can hand work to background agents on runners with dispatch_to_runner, and follow it with list_running_sessions / read_session / steer_task. Use a runner for anything you cannot do inside this chat:",
    "- Code changes: pass `repo` (owner/name) to have it cloned, or `cwd` for a project the runner already has.",
    "- Anything that needs a real web browser, on a runner with the `browser` capability: browsing or searching a site, testing a web app, filling forms, adding items to a cart, reading pages that block plain fetches. Omit repo and cwd and set browser=true.",
    "Never tell the user you can't browse, click, or act on a website while a browser-capable runner is online — dispatch it instead. Web search and fetch tools are still fine for quick lookups. The runner tries its own browser first and only falls back to a paid cloud browser when a site blocks it.",
  ];
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

function buildRunnerSection(): string | undefined {
  try {
    const dispatcher = getDispatcher();
    const runners = dispatcher.listRunners().map((r) => ({ ...r, location: dispatcher.runnerInfo(r.runnerId)?.location ?? null }));
    return renderRunnerSection(runners);
  } catch {
    return undefined; // dispatcher unavailable → runner tools are disabled too
  }
}

/** Owner-only system prompt block: ops tools + live runners. */
export function buildOwnerPromptSection(): string | undefined {
  const parts = [buildOpsTriagePromptSection(), buildRunnerSection()].filter((s): s is string => !!s);
  return parts.length ? parts.join("\n\n") : undefined;
}
