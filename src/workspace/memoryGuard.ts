import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionFactory, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { MEMORY_MD_CAP, USER_MD_CAP } from "./home.ts";
import { containsSecret } from "./secretPatterns.ts";

export { containsSecret };

/**
 * Seatbelt on the agent's own memory writes: no secrets in USER.md / MEMORY.md / DREAMS.md / memory/, and
 * no write that grows USER.md or MEMORY.md past its cap. Edits and writes are checked exactly. Bash is
 * best-effort text matching on redirects, tee, cp/mv/dd and in-place sed/perl that name a memory path; it
 * misses secrets that arrive by expansion (`echo "$TOKEN" >> MEMORY.md`, `$(cat f)`), interpreter writes
 * (`python -c`, `node -e`), a relative path after `cd memory`, install/ln/rsync, and never checks caps.
 * scanMemoryForSecrets backs this up with a warn before each memory commit.
 */

type Log = { warn: (obj: object, msg: string) => void };

export interface MemoryGuardOptions {
  home: string;
  /** The session cwd; relative tool paths resolve against it. */
  cwd: string;
}

/** Guarded top-level memory files and their char caps (undefined: no cap). */
const MEMORY_FILES: Record<string, number | undefined> = { "USER.md": USER_MD_CAP, "MEMORY.md": MEMORY_MD_CAP, "DREAMS.md": undefined };
const BASH_WRITE = /(?:>>?|\btee\b|\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-[a-z]*i|\bcp\b|\bmv\b|\bdd\b)/;
const BASH_MEMORY_PATH = /(?:^|[\s"'=/>])(?:USER\.md|MEMORY\.md|DREAMS\.md|memory\/)/;

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

interface MemoryTarget {
  /** The real path of the file being written. */
  path: string;
  cap: number | undefined;
}

/** The memory file `raw` names, or null for any other path. */
export function memoryTarget(raw: string, opts: MemoryGuardOptions): MemoryTarget | null {
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  const real = realpathDeep(resolve(opts.cwd, p));
  const home = realpathDeep(resolve(opts.home));
  for (const [name, cap] of Object.entries(MEMORY_FILES)) {
    if (real === join(home, name)) return { path: real, cap };
  }
  if (real.startsWith(`${join(home, "memory")}/`)) return { path: real, cap: undefined };
  return null;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

interface EditPair {
  oldText: string;
  newText: string;
}

// Pi normalizes edit input to an `edits` array before tool_call fires (tools/edit.js).
function editPairs(input: Record<string, unknown>): EditPair[] {
  const raw: unknown[] = Array.isArray(input.edits) ? input.edits : [];
  return raw
    .filter((e): e is EditPair => typeof (e as EditPair)?.oldText === "string" && typeof (e as EditPair)?.newText === "string")
    .map((e) => ({ oldText: e.oldText, newText: e.newText }));
}

/** Why a write to a memory file must be refused, or null to let it through. */
export function checkMemoryWrite(toolName: string, input: Record<string, unknown>, opts: MemoryGuardOptions): string | null {
  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (BASH_WRITE.test(command) && BASH_MEMORY_PATH.test(command) && containsSecret(command)) return "secret";
    return null;
  }
  if (toolName !== "edit" && toolName !== "write") return null;
  if (typeof input.path !== "string") return null;
  const target = memoryTarget(input.path, opts);
  if (!target) return null;

  let added: string;
  let delta: number;
  if (toolName === "write") {
    added = typeof input.content === "string" ? input.content : "";
    delta = added.length - readOrEmpty(target.path).length;
  } else {
    const pairs = editPairs(input);
    // Only the text being added: a file that already holds a secret must stay editable, so it can be removed.
    added = pairs.map((e) => e.newText).join("\n");
    delta = pairs.reduce((sum, e) => sum + e.newText.length - e.oldText.length, 0);
  }
  if (containsSecret(added)) return "secret";
  if (target.cap !== undefined && delta > 0) {
    const projected = readOrEmpty(target.path).length + delta;
    // A write that shrinks a file already over its cap is curation, so only growth past the cap is refused.
    if (projected > target.cap) return `cap:${basename(target.path)}:${target.cap}:${projected}`;
  }
  return null;
}

function blockReason(rule: string, toolName: string): string {
  if (rule === "secret") {
    return (
      `Blocked by the memory guard: this ${toolName} would store something that looks like a secret (token, key, ` +
      "password hash or long random string) in a memory file. Never store secrets in memory. If it's a commit SHA or " +
      "an id, shorten it (e.g. the first 12 characters) and try again."
    );
  }
  const [, name, cap, projected] = rule.split(":");
  return (
    `Blocked by the memory guard: ${name} would grow to ${projected} chars, over its ${cap}-char cap. ` +
    `Curate it first: merge duplicates, prune stale entries and tighten wording, then add the new entry.`
  );
}

export function createMemoryGuardExtension(opts: MemoryGuardOptions & { log: Log }): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event): ToolCallEventResult | undefined => {
      const input = event.input as Record<string, unknown>;
      const rule = checkMemoryWrite(event.toolName, input, opts);
      if (!rule) return undefined;
      opts.log.warn({ tool: event.toolName, rule: rule.split(":").slice(0, 2).join(":") }, "memory guard blocked a write");
      return { block: true, reason: blockReason(rule, event.toolName) };
    });
  };
}

/** Memory files (relative to home) that hold something secret-shaped; reads names only, never logs content. */
export function scanMemoryForSecrets(home: string): string[] {
  const found: string[] = [];
  const check = (rel: string) => {
    try {
      if (containsSecret(readFileSync(join(home, rel), "utf8"))) found.push(rel);
    } catch {
      // Missing or unreadable.
    }
  };
  for (const name of Object.keys(MEMORY_FILES)) check(name);
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(home, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const child = `${rel}/${name}`;
      try {
        if (statSync(join(home, child)).isDirectory()) walk(child);
        else check(child);
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };
  walk("memory");
  return found;
}
