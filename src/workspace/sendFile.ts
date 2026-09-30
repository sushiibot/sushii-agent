import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DELIVER_FILE_MAX_BYTES } from "../orchestration/contracts.ts";
import { checkToolCall, guardedPaths } from "./secretGuard.ts";
import { containsSecret } from "./secretPatterns.ts";

export const SEND_FILE_TOOL = "send_file";

export interface SendFilePaths {
  /** The session cwd; relative paths resolve against it. */
  cwd: string;
  home: string;
  agentDir: string;
  /** Holds the outbox and its staged files. */
  stateDir: string;
}

/** Takes a checked file's bytes into the current turn's reply; returns the tool's answer, throws to refuse. */
export interface SendFileSink {
  attach(file: { data: Buffer; name: string; contentType: string }): string;
}

// Keyed by chat session: PersonalSession binds its sink when it attaches a session the factory built.
const sinks = new WeakMap<object, SendFileSink>();

export function bindSendFileSink(session: object, sink: SendFileSink): void {
  sinks.set(session, sink);
}

const SYSTEM_DIRS = ["/proc", "/sys", "/dev"];
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The real path of a file the agent may send, or why not. Mirrors the secret guard's read rules and
 *  adds the auth files, the state dir (outbox) and the kernel's pseudo-filesystems. */
export function checkSendablePath(raw: string, paths: SendFilePaths): { ok: true; path: string } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: false, error: "path is empty" };
  const rule = checkToolCall("read", { path: raw }, guardedPaths({ agentDir: paths.agentDir, cwd: paths.cwd, home: paths.home }));
  if (rule) return { ok: false, error: `blocked (${rule}): that path holds credentials or agent config` };
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  const lexical = resolve(paths.cwd, p);
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    return { ok: false, error: `no such file: ${raw}` };
  }
  for (const candidate of [lexical, real]) {
    if (basename(candidate) === "auth.json") return { ok: false, error: "blocked (auth-file): that path holds credentials" };
    if ([paths.agentDir, paths.stateDir].some((d) => inside(candidate, resolve(d)) || inside(candidate, realOrSelf(resolve(d))))) {
      return { ok: false, error: "blocked (state): the workspace's own state and agent dirs can't be sent" };
    }
    if (SYSTEM_DIRS.some((d) => inside(candidate, d))) return { ok: false, error: "blocked (system): not a regular file" };
  }
  return { ok: true, path: real };
}

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

function statOrNull(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Files whose bytes must never leave, by identity: a hardlink under an innocent name is the same inode.
 *  Stat'd per call, since an atomic rewrite gives them a new inode. */
function protectedFiles(paths: SendFilePaths): Stats[] {
  return [join(paths.agentDir, "auth.json"), join(paths.stateDir, "outbox.jsonl")].map(statOrNull).filter((s): s is Stats => s !== null);
}

// Text past this is not scanned, but nothing past the per-file send cap can be sent anyway.
const TEXT_SNIFF_BYTES = 8192;

// The detector's dotted-token pattern backtracks across a run of token characters, so its time grows with
// the sum of squared run lengths; past this budget (roughly 0.2s) the file is refused rather than scanned.
const SCAN_COST_MAX = 2e9;

function isTokenByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d;
}

function scanCost(data: Buffer): number {
  let cost = 0;
  let run = 0;
  for (const b of data) {
    if (isTokenByte(b)) run++;
    else {
      cost += run * run;
      run = 0;
    }
  }
  return cost + run * run;
}

/** Whether the bytes look like text worth scanning: no NUL in the first chunk. */
function looksLikeText(data: Buffer): boolean {
  return !data.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

/** Reads a checked file once, through one descriptor, so the identity check, the secret scan and the
 *  bytes sent can't diverge. Throws to refuse. */
export function readSendableFile(path: string, paths: SendFilePaths, maxBytes: number): Buffer {
  const before = statSync(path);
  // A FIFO would block open() and the whole event loop with it.
  if (!before.isFile()) throw new Error("not a regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !sameFile(st, before)) throw new Error("the file changed while it was being read");
    if (protectedFiles(paths).some((p) => sameFile(p, st))) throw new Error("blocked (auth-file): that file is a link to a credentials file");
    if (st.size > maxBytes) throw new Error(`${st.size} bytes is over the ${maxBytes}-byte limit`);
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    for (;;) {
      const read = readSync(fd, buf, n, buf.length - n, null);
      if (read === 0) break;
      n += read;
      // The file grew past the cap after the stat.
      if (n > maxBytes) throw new Error(`over the ${maxBytes}-byte limit`);
    }
    const data = buf.subarray(0, n);
    if (looksLikeText(data) && scanCost(data) > SCAN_COST_MAX) {
      throw new Error("blocked (secret): the file has runs of token characters too long for the secret detector to check, so it won't be sent");
    }
    if (looksLikeText(data) && containsSecret(data.toString("utf8"))) {
      throw new Error("blocked (secret): the secret detector found what looks like a credential (a token, key or long hash) in this file, so it won't be sent");
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Discord keeps only these characters in an attachment name; anything else would break `attachment://` references. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  const clipped = cleaned.length > 100 ? cleaned.slice(cleaned.length - 100) : cleaned;
  return clipped || "file";
}

export function contentTypeOf(path: string): string {
  const type = Bun.file(path).type;
  return type.split(";")[0]?.trim() || "application/octet-stream";
}

export function createSendFileTool(paths: SendFilePaths, session: () => object | null, maxBytes = DELIVER_FILE_MAX_BYTES): ToolDefinition {
  return {
    name: SEND_FILE_TOOL,
    label: "send_file",
    promptSnippet: "send_file: attach a workspace file (screenshot, PDF, chart) to your reply to drk",
    description:
      "Attach a file from the workspace to your reply to drk (a screenshot, PDF, chart, export). The file is " +
      "copied when you call this and goes out with the reply that ends this turn. Limits: 8 MB per file, 10 files " +
      "and 11 MB in total per turn. Files under Pi's config/auth dirs or the workspace state dir can't be sent, " +
      "and neither can a text file the secret detector flags (tokens, keys, long hex hashes).",
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file, absolute or relative to the working directory." }),
      name: Type.Optional(Type.String({ description: "File name drk sees; defaults to the file's own name." })),
    }) as ToolDefinition["parameters"],
    execute: async (_toolCallId: string, params: unknown) => {
      const { path, name } = params as { path: string; name?: string };
      const current = session();
      const sink = current ? sinks.get(current) : undefined;
      if (!sink) throw new Error("send_file isn't available in this session");
      const checked = checkSendablePath(path, paths);
      if (!checked.ok) throw new Error(checked.error);
      let data: Buffer;
      try {
        data = readSendableFile(checked.path, paths, maxBytes);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`can't send ${path}: ${why}`);
      }
      const text = sink.attach({ data, name: safeFileName(name?.trim() || basename(checked.path)), contentType: contentTypeOf(checked.path) });
      return { content: [{ type: "text", text }], details: {} } satisfies AgentToolResult<unknown>;
    },
  } as ToolDefinition;
}
