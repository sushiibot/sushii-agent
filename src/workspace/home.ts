import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runnerGit, runnerGitEnv } from "../orchestration/runner/runnerGit.ts";
import { getLogger } from "../logger.ts";

const log = getLogger("workspace.home");

export const HOME_TEMPLATE_DIR = join(import.meta.dir, "home-template");

/** Home path → template file name; dotfiles are stored undotted so they don't act on this repo. */
const TEMPLATE_FILES: Record<string, string> = {
  "AGENTS.md": "AGENTS.md",
  "SOUL.md": "SOUL.md",
  "USER.md": "USER.md",
  "MEMORY.md": "MEMORY.md",
  "DREAMS.md": "DREAMS.md",
  ".agents/skills/README.md": "agents-skills-README.md",
  ".agents/skills/session-history/SKILL.md": "agents-skills-session-history-SKILL.md",
  ".gitignore": "gitignore",
};

const HOME_DIRS = ["memory", ".agents/skills", "projects", "scratch"];

/** The only paths the workspace itself ever stages in the home repo. */
export const HOME_TRACKED_PATHS = ["USER.md", "MEMORY.md", "DREAMS.md", "memory/", "SOUL.md", "AGENTS.md", ".agents/"];

/** The memory subset of HOME_TRACKED_PATHS, which the workspace auto-commits. */
export const MEMORY_PATHS = ["USER.md", "MEMORY.md", "DREAMS.md", "memory/"];

export const USER_MD_CAP = 4000;
export const MEMORY_MD_CAP = 8000;

/** Loaded after Pi's own discovery (which already picks up `~/AGENTS.md`), in this order. */
const CONTEXT_FILES: { name: string; cap?: number }[] = [
  { name: "SOUL.md" },
  { name: "USER.md", cap: USER_MD_CAP },
  { name: "MEMORY.md", cap: MEMORY_MD_CAP },
];

const GIT_NAME = "sushii-workspace";
const GIT_EMAIL = "workspace@localhost";

export function readHomeTemplate(homePath: string): string {
  const file = TEMPLATE_FILES[homePath];
  if (!file) throw new Error(`no home template for ${homePath}`);
  return readFileSync(join(HOME_TEMPLATE_DIR, file), "utf8");
}

export interface ScaffoldResult {
  created: string[];
  initialized: boolean;
}

/** Creates whatever is missing under `home` (never overwrites) and git-inits it on first run. */
export async function scaffoldHome(home: string): Promise<ScaffoldResult> {
  mkdirSync(home, { recursive: true });
  for (const dir of HOME_DIRS) mkdirSync(join(home, dir), { recursive: true });

  const created: string[] = [];
  for (const homePath of Object.keys(TEMPLATE_FILES)) {
    const target = join(home, homePath);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    // "wx" so a file created concurrently is still never clobbered.
    writeFileSync(target, readHomeTemplate(homePath), { flag: "wx" });
    created.push(homePath);
  }

  // Keyed on HEAD, not .git, so a first run that died between init and the initial commit is finished here.
  const initialized = await serialized(async () => {
    const git = runnerGit(home);
    if (!existsSync(join(home, ".git"))) await git.init();
    await git.addConfig("user.name", GIT_NAME, false, "local");
    await git.addConfig("user.email", GIT_EMAIL, false, "local");
    await git.addConfig("commit.gpgsign", "false", false, "local");
    if (await hasHead(home)) return false;
    await commitPaths(home, [".gitignore", ...HOME_TRACKED_PATHS], "chore(home): scaffold workspace home", true);
    return true;
  });

  if (created.length > 0 || initialized) log.info({ home, created, initialized }, "home scaffolded");
  return { created, initialized };
}

export interface ContextFile {
  path: string;
  content: string;
}

export function capContent(content: string, cap: number): { content: string; truncated: boolean } {
  if (content.length <= cap) return { content, truncated: false };
  // Don't split a surrogate pair (an emoji) at the cut.
  const end = /[\uD800-\uDBFF]/.test(content.charAt(cap - 1)) ? cap - 1 : cap;
  return { content: `${content.slice(0, end)}\n[truncated at ${cap} chars — curate this file]\n`, truncated: true };
}

/** SOUL/USER/MEMORY from `home`, capped; a missing file is skipped. Read fresh on every call. */
export function loadHomeContextFiles(home: string): ContextFile[] {
  const files: ContextFile[] = [];
  for (const { name, cap } of CONTEXT_FILES) {
    const path = join(home, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (cap === undefined) {
      files.push({ path, content: raw });
      continue;
    }
    const { content, truncated } = capContent(raw, cap);
    if (truncated) log.warn({ path, length: raw.length, cap }, "context file over its cap; truncated at load");
    files.push({ path, content });
  }
  return files;
}

/** For `DefaultResourceLoader`'s `agentsFilesOverride`: Pi's discovered files, then the home context files. */
export function homeAgentsFilesOverride(home: string) {
  return (base: { agentsFiles: ContextFile[] }): { agentsFiles: ContextFile[] } => {
    const extra = loadHomeContextFiles(home).filter((f) => !base.agentsFiles.some((b) => b.path === f.path));
    return { agentsFiles: [...base.agentsFiles, ...extra] };
  };
}

async function hasHead(home: string): Promise<boolean> {
  try {
    await runnerGit(home).raw(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function commitPaths(home: string, paths: string[], message: string, initial = false): Promise<{ committed: boolean; sha?: string }> {
  const git = runnerGit(home);
  const tracked = (await git.raw(["ls-files", "--", ...paths])).split("\n").filter(Boolean);
  const present = paths.filter((p) => existsSync(join(home, p)) || tracked.some((t) => t === p || (p.endsWith("/") && t.startsWith(p))));
  if (present.length === 0) return { committed: false };
  await git.raw(["add", "-A", "--", ...present]);
  const staged = (await git.raw(["diff", "--cached", "--name-only", "--no-renames", "--", ...present])).split("\n").filter(Boolean);
  if (staged.length === 0) return { committed: false };
  // Exact staged names, so anything else the agent staged stays out; a pathspec git doesn't know
  // (an empty dir) would fail `commit`. --no-renames lists a rename's deleted side too.
  // --no-verify skips pre-commit only; hooksPath also stops an agent-planted post-commit hook. Passed as
  // git's own `-c` env form because simple-git refuses a literal `-c core.hooksPath`.
  await git
    .env({ ...runnerGitEnv(), GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/dev/null'" })
    .raw(["commit", "--no-verify", "-m", message, ...(initial ? [] : ["--", ...staged])]);
  const sha = (await git.revparse(["HEAD"])).trim();
  return { committed: true, sha };
}

/** Commits changes to the memory/persona files only (or the given subset); a no-op when none changed. One commit at a time. */
export function commitHome(message: string, opts: { home?: string; paths?: string[] } = {}): Promise<{ committed: boolean; sha?: string }> {
  const home = opts.home ?? process.env.HOME;
  if (!home) return Promise.reject(new Error("commitHome: HOME is not set"));
  const paths = opts.paths ? opts.paths.filter((p) => HOME_TRACKED_PATHS.includes(p)) : HOME_TRACKED_PATHS;
  return serialized(() => commitPaths(home, paths, message));
}
