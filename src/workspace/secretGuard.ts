import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionFactory, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/**
 * Deterministic seatbelt against the workspace agent reading Pi's credentials (auth.json holds a live
 * ChatGPT refresh token) or a process environment. The agent shares the workspace's uid, so file
 * permissions can't do this. The path checks are exact; the bash check is best-effort substring and
 * glob matching on the command text, and misses computed paths (base64, `$var` splicing, scripts
 * written first and run later).
 */

type Log = { warn: (obj: object, msg: string) => void };

export interface SecretGuardOptions {
  agentDir: string;
  /** The session cwd; relative tool paths resolve against it. */
  cwd: string;
  /** HOME. `<home>/.pi/` holds project extensions and settings Pi loads in-process, so writes there are blocked. */
  home: string;
}

export interface GuardedPaths {
  cwd: string;
  agentDirs: string[];
  /** Basenames of the agent dir, to catch relative references like `../pi-agent/`. */
  agentDirNames: string[];
  projectConfigDirs: string[];
}

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
// Pi's grep and find pass --hidden, so a search rooted above a protected dir walks into it.
const RECURSIVE_TOOLS = new Set(["grep", "find"]);
const PROC_SENSITIVE = /^\/proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/(?:environ|cmdline|mem)$/;
const NETWORK_TOOL = /\b(?:curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|telnet|ftp|openssl)\b|\/dev\/(?:tcp|udp)\//;
const ENV_DUMP = /(?:^|[\s|;&(`]|\$\()(?:env|printenv)(?=$|[\s|;&)>`])/;
const GLOB_CHARS = /[*?[]/;

function realpathDeep(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return p;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

function variants(p: string): string[] {
  const lexical = resolve(p);
  const real = realpathDeep(lexical);
  return real === lexical ? [lexical] : [lexical, real];
}

export function guardedPaths(opts: SecretGuardOptions): GuardedPaths {
  const agentDirs = variants(opts.agentDir);
  return {
    cwd: opts.cwd,
    agentDirs,
    agentDirNames: [...new Set(agentDirs.map((d) => basename(d)))].filter((n) => n.length >= 4),
    projectConfigDirs: variants(join(opts.home, ".pi")),
  };
}

/** Mirrors Pi's own resolution (strip `@`, expand `~`, resolve against cwd), then follows symlinks. */
function resolveToolPath(raw: string, cwd: string): string[] {
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return variants(resolve(cwd, p));
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);

function checkPath(toolName: string, input: Record<string, unknown>, paths: GuardedPaths): string | null {
  const raw = typeof input.path === "string" && input.path.trim() ? input.path : ".";
  const candidates = resolveToolPath(raw, paths.cwd);
  for (const p of candidates) {
    if (paths.agentDirs.some((d) => inside(p, d))) return "agent-dir";
    if (PROC_SENSITIVE.test(p)) return "proc";
    if (WRITE_TOOLS.has(toolName) && paths.projectConfigDirs.some((d) => inside(p, d))) return "project-config";
    if (RECURSIVE_TOOLS.has(toolName)) {
      if (paths.agentDirs.some((d) => inside(d, p))) return "agent-dir-ancestor";
      if (inside(p, "/proc") || inside("/proc", p)) return "proc";
    }
  }
  return null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) out += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function globMatches(glob: string, target: string): boolean {
  try {
    return globToRegex(glob).test(target);
  } catch {
    return false;
  }
}

/** Best-effort: text heuristics on the command, after stripping quotes and backslashes. */
export function checkBashCommand(command: string, paths: GuardedPaths): string | null {
  const norm = command.replace(/['"\\]/g, "").replace(/\/{2,}/g, "/");
  if (paths.agentDirs.some((d) => norm.includes(d))) return "agent-dir";
  if (paths.agentDirNames.some((n) => new RegExp(`(?:^|[\\s/])${escapeRegex(n)}(?:$|[\\s/])`).test(norm))) return "agent-dir";
  if (/auth\.json/.test(norm)) return "auth-file";
  if (norm.includes("/proc/") && /environ|cmdline|\bmem\b/.test(norm)) return "proc";
  if (ENV_DUMP.test(norm) && NETWORK_TOOL.test(norm)) return "env-exfil";

  const sensitive = [
    ...paths.agentDirs.flatMap((d) => [d, join(d, "auth.json")]),
    "/proc/self/environ",
    "/proc/1/environ",
  ];
  for (const token of norm.split(/[\s;|&()<>=`$,{}]+/)) {
    if (!GLOB_CHARS.test(token)) continue;
    if (token.includes("/") && sensitive.some((s) => globMatches(token, s))) return "glob";
    const name = token.slice(token.lastIndexOf("/") + 1);
    const literals = name.replace(/[*?]|\[[^\]]*\]/g, "").length;
    if (literals >= 4 && name !== "*.json" && globMatches(name, "auth.json")) return "glob";
  }
  return null;
}

export function checkToolCall(toolName: string, input: Record<string, unknown>, paths: GuardedPaths): string | null {
  if (toolName === "bash") return typeof input.command === "string" ? checkBashCommand(input.command, paths) : null;
  if (PATH_TOOLS.has(toolName)) return checkPath(toolName, input, paths);
  return null;
}

export function createSecretGuardExtension(opts: SecretGuardOptions & { log: Log }): ExtensionFactory {
  const paths = guardedPaths(opts);
  return (pi) => {
    pi.on("tool_call", (event): ToolCallEventResult | undefined => {
      const rule = checkToolCall(event.toolName, event.input as Record<string, unknown>, paths);
      if (!rule) return undefined;
      opts.log.warn({ tool: event.toolName, rule }, "secret guard blocked a tool call");
      return {
        block: true,
        reason:
          `Blocked by the secret guard (${rule}): this ${event.toolName} call would touch Pi's config/auth files ` +
          "or a process environment, which hold credentials. Don't retry it another way; tell drk if you need something from there.",
      };
    });
  };
}
