import { spawnSync } from "node:child_process";
import { arch, platform } from "node:os";

export const ENV_CONTEXT_PATH = "sushii-runner://environment.md";

// CLIs worth telling the agent about when present. Absent ones are simply not listed, so this can
// name tools the current image lacks (e.g. a browser) without the context lying.
const CANDIDATE_TOOLS: { name: string; purpose: string; versionArgs?: string[] }[] = [
  { name: "git", purpose: "version control" },
  { name: "gh", purpose: "GitHub CLI (PRs, issues, API)" },
  { name: "rg", purpose: "ripgrep, fast code search" },
  { name: "bun", purpose: "JS/TS runtime, package manager, test runner; `bunx` runs one-off npm CLIs" },
  { name: "node", purpose: "Node.js runtime" },
  { name: "python3", purpose: "Python" },
  { name: "uv", purpose: "Python package/project manager" },
  { name: "curl", purpose: "HTTP requests" },
  { name: "jq", purpose: "JSON processing" },
  { name: "pdftotext", purpose: "extract text from PDFs (poppler)", versionArgs: ["-v"] },
  { name: "lychee", purpose: "link checker" },
  { name: "agent-browser", purpose: "browser automation for agents; run `agent-browser --help`" },
];

export interface ToolInfo {
  name: string;
  purpose: string;
  version: string | null;
}

type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string } | null;

const defaultRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3000 });
  if (r.error) return null; // ENOENT → not installed
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function probeTools(run: Runner = defaultRun): ToolInfo[] {
  const found: ToolInfo[] = [];
  for (const tool of CANDIDATE_TOOLS) {
    const r = run(tool.name, tool.versionArgs ?? ["--version"]);
    if (!r) continue;
    // Some tools (pdftotext -v) print their version to stderr.
    const firstLine = (r.stdout.trim() || r.stderr.trim()).split("\n")[0]?.trim() ?? "";
    found.push({ name: tool.name, purpose: tool.purpose, version: firstLine.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null });
  }
  return found;
}

export interface EnvironmentFacts {
  runnerId: string;
  location: string | null;
  workspaceRoot: string | null;
  worktreeTtlHours: number;
  platform?: string;
  arch?: string;
}

export function buildEnvironmentContext(facts: EnvironmentFacts, tools: ToolInfo[]): string {
  const where = facts.location ? ` (${facts.location})` : "";
  const lines = [
    "# Runner environment",
    "",
    `You are running unattended on sushii runner \`${facts.runnerId}\`${where}, ${facts.platform ?? platform()}/${facts.arch ?? arch()}. No human watches this terminal.`,
    "",
    "## Installed CLI tools",
    "",
    ...tools.map((t) => `- \`${t.name}\`${t.version ? ` ${t.version}` : ""} — ${t.purpose}`),
    "",
    "Tools not listed here are not installed.",
  ];
  if (facts.workspaceRoot) {
    lines.push(
      "",
      "## Workspace",
      "",
      `- Repositories are cloned under \`${facts.workspaceRoot}\`. Each task runs in its own git worktree (\`<clone>.wt/<taskId>\`) on its own branch \`sushii-runner/<taskId>\`, cut from the latest default branch. That worktree is your working directory.`,
      "- The shared clone stays on a detached HEAD. Do not check out branches there.",
      `- A task worktree is deleted once its PR merges or after ${facts.worktreeTtlHours}h idle. Commit anything worth keeping.`,
      "- When a task targets a repository, git push and `gh` are already authenticated for that repository only.",
      "- Only the workspace persists. Anything installed elsewhere is lost when the runner restarts.",
    );
  }
  return lines.join("\n");
}
