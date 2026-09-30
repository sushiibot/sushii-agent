import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkToolCall, guardedPaths } from "./secretGuard.ts";

export const SEND_FILE_TOOL = "send_file";

export interface SendFilePaths {
  /** The session cwd; relative paths resolve against it. */
  cwd: string;
  home: string;
  agentDir: string;
  /** Holds the outbox and its staged files. */
  stateDir: string;
}

/** Takes a checked file into the current turn's reply; returns the tool's answer, throws to refuse. */
export interface SendFileSink {
  attach(file: { source: string; name: string; contentType: string }): string;
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

export function createSendFileTool(paths: SendFilePaths, session: () => object | null): ToolDefinition {
  return {
    name: SEND_FILE_TOOL,
    label: "send_file",
    promptSnippet: "send_file: attach a workspace file (screenshot, PDF, chart) to your reply to drk",
    description:
      "Attach a file from the workspace to your reply to drk (a screenshot, PDF, chart, export). The file is " +
      "copied when you call this and goes out with the reply that ends this turn. Limits: 8 MB per file, 10 files " +
      "and 11 MB in total per turn. Files under Pi's config/auth dirs or the workspace state dir can't be sent.",
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
      const text = sink.attach({ source: checked.path, name: safeFileName(name?.trim() || basename(checked.path)), contentType: contentTypeOf(checked.path) });
      return { content: [{ type: "text", text }], details: {} } satisfies AgentToolResult<unknown>;
    },
  } as ToolDefinition;
}
