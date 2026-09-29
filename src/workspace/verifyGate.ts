import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolveReal } from "./memoryGuard.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";

/**
 * Verify-before-done: when a run changed code under projects/ and ran no check after the last change,
 * the run is held open once with a follow-up asking for the check. Bash detection is best-effort text
 * matching; git add/commit/push never count as a change.
 */

export const VERIFY_CUSTOM_TYPE = "sushii-verify-gate";

type Log = { info: (obj: object, msg: string) => void };

export interface VerifyGateOptions {
  home: string;
  /** The session cwd; relative tool paths resolve against it. */
  cwd: string;
  log?: Log;
  /** True once the loop guard has told the agent to stop retrying this run; the gate then stays quiet. */
  loopNudged?: () => boolean;
}

const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FILLER = new Set(["run", "run-script", "exec", "x", "-m", "--", "timeout", "time", "nice", "env"]);
const CHECK_PROGRAM = /^(?:make|tsc|pytest|vitest|jest|eslint|mypy|ruff|biome)$/;
const RUNNER = /^(?:bun|bunx|npm|npx|pnpm|yarn|cargo|go|uv|deno|python3?|poetry|just|mvn|gradle|gradlew|tox|nox)$/;
const CHECK_WORD = /^(?:test|check|lint|typecheck|type-check|tsc|pytest|vitest|jest|eslint|clippy|vet|mypy|ruff)(?::[\w.-]+)?$/;

function segments(command: string): string[][] {
  return command
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
}

/** Whether a bash command runs a test, typecheck, lint or other check. */
export function isCheckCommand(command: string): boolean {
  for (const tokens of segments(command)) {
    const words = tokens
      .filter((t) => !ENV_ASSIGN.test(t) && !/^\d+[smh]?$/.test(t))
      .map((t) => t.split("/").pop() ?? t)
      .filter((w) => !FILLER.has(w));
    const [program, ...rest] = words;
    if (!program) continue;
    if (CHECK_PROGRAM.test(program)) return true;
    // `uv run python -m pytest`: a runner can wrap another runner.
    if (RUNNER.test(program) && rest.slice(0, 2).some((w) => CHECK_WORD.test(w))) return true;
  }
  return false;
}

const GIT_MUTATE = /\bgit\s+(?:-C\s+\S+\s+)?(?:apply|am|merge|rebase|cherry-pick|revert|restore|pull|reset\s+--hard|checkout\s+(?:\S+\s+)?--|stash\s+(?:pop|apply))\b/;
const FILE_MUTATE = /(?:\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-[a-z]*i|\btee\b|(?:^|[\s;&|(])(?:mv|cp|rm|patch|touch|truncate)\s)/;
const REPO_REMOVAL = /^\s*rm\s+(?:-[A-Za-z]+\s+)*\S*projects\/[A-Za-z0-9._-]+\/?\s*$/;
const PROJECT_REF = /(?:^|[\s"'=/(])projects\/([A-Za-z0-9._-]+)/;

function hasRedirect(command: string): boolean {
  const stripped = command.replace(/\d*>&\d/g, "").replace(/[&\d]*>>?\s*\/dev\/null/g, "").replace(/=>/g, "");
  return /[^<]>/.test(` ${stripped}`);
}

/** The repo under projects/ a bash command changes, or null when it doesn't look like it changes one. */
export function bashChangedRepo(command: string): string | null {
  const repo = command.match(PROJECT_REF)?.[1];
  if (!repo) return null;
  // Removing a whole repo leaves nothing to check.
  if (REPO_REMOVAL.test(command)) return null;
  return GIT_MUTATE.test(command) || FILE_MUTATE.test(command) || hasRedirect(command) ? repo : null;
}

/** The repo under projects/ that `path` belongs to, or null. */
export function projectRepoOf(path: string, opts: Pick<VerifyGateOptions, "home" | "cwd">): string | null {
  const projects = resolveReal(join(resolve(opts.home), "projects"), opts.cwd);
  const rel = relative(projects, resolveReal(path, opts.cwd));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep)[0];
}

const CANT_RUN =
  /\b(?:can(?:'|’)?t|cannot|could(?:n(?:'|’)?t| not)|unable to|won(?:'|’)?t be able to|not able to)\b[^.\n]{0,80}\b(?:run|execute|test|verify|check|typecheck|lint)/i;
const NO_CHECKS = /\bno (?:tests?|test suite|checks?|typecheck|linter)\b[^.\n]{0,40}\b(?:exist|configured|set up|available|to run|here|in this repo)/i;

/** Whether the text says why the check can't run. */
export function explainsNoCheck(text: string): boolean {
  return CANT_RUN.test(text) || NO_CHECKS.test(text);
}

function lastAssistantText(context: AgentBeforeSettleEvent["context"]): string {
  const messages = context.contextMessages as Array<{ role?: string; content?: unknown }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (!Array.isArray(m.content)) return "";
    return m.content
      .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export function verifyFollowUp(repos: string[]): string {
  const where = repos.length ? repos.map((r) => `projects/${r}`).join(", ") : "a project";
  return (
    `You changed code in ${where}. Before finishing, run the relevant check (tests, typecheck, lint, or the repo's ` +
    "documented check) and report the result, or explain why it can't run."
  );
}

export function createVerifyGateExtension(opts: VerifyGateOptions): ExtensionFactory {
  return (pi) => {
    let hidden = false;
    let nudged = false;
    let repos = new Set<string>();
    let unverified = false;

    pi.on("before_agent_start", (event) => {
      hidden = event.prompt.startsWith(FLUSH_MARKER);
      nudged = false;
      repos = new Set();
      unverified = false;
    });

    pi.on("tool_result", (event) => {
      if (event.toolName === "edit" || event.toolName === "write") {
        const path = event.input.path;
        if (event.isError || typeof path !== "string") return;
        const repo = projectRepoOf(path, opts);
        if (repo) {
          repos.add(repo);
          unverified = true;
        }
        return;
      }
      if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
      const command = event.input.command;
      const repo = bashChangedRepo(command);
      if (repo) {
        repos.add(repo);
        unverified = true;
      }
      // A failing check still counts: the agent saw the result and has to report it.
      if (isCheckCommand(command)) unverified = false;
    });

    pi.on("agent_before_settle", (event): BoundaryResult | undefined => {
      if (event.outcome !== "completed" || hidden || nudged || !unverified || opts.loopNudged?.()) return undefined;
      if (explainsNoCheck(lastAssistantText(event.context))) return undefined;
      nudged = true;
      const content = verifyFollowUp([...repos]);
      opts.log?.info({ repos: [...repos] }, "verify gate: code changed without a check; asking for one");
      return {
        entries: [...event.entries, { type: "custom_message", customType: VERIFY_CUSTOM_TYPE, content, display: false }],
        continue: true,
      };
    });
  };
}
