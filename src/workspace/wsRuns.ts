import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { latestRuns, runLogPath, tailLines, type RunRecord } from "./runLog.ts";
import { resolveStateDir, sessionRoots } from "./sessionPaths.ts";
import { redact } from "./secretPatterns.ts";
import { publicAuthError } from "./chatgptFallback.ts";

export { redact };

// The sanctioned way for the agent to read its own session files, which live under the secret-guarded
// agent dir. The session roots come from pinned agent dirs; every path in runs.jsonl is agent-writable,
// so reads are confined to real *.jsonl Pi session files under those roots and all output is redacted.

const USAGE = `usage:
  ws-runs list [--limit N] [--agent NAME] [--parent [RUNID]] [--since ISO]
  ws-runs show [runId] [--full]        (runId defaults to $WS_RUN_ID, the current run)
  ws-runs search <text> [--limit N]`;

const TOOL_RESULT_MAX = 300;
const TOOL_ARGS_MAX = 160;
const SNIPPET_RADIUS = 60;

export interface WsRunsIo {
  env: NodeJS.ProcessEnv;
  /** From `pinnedAgentDirs`, read once at process start; never from agent-writable files. */
  agentDirs: string[];
  out: (line: string) => void;
  err: (line: string) => void;
}

// --- confined session file access --------------------------------------------------------------

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

// A root that is itself a symlink could point anywhere, e.g. `<agentDir>/chat -> <agentDir>`.
function realRoots(agentDirs: string[]): string[] {
  const roots: string[] = [];
  for (const r of agentDirs.flatMap(sessionRoots)) {
    try {
      const st = lstatSync(r);
      if (st.isDirectory() && !st.isSymbolicLink()) roots.push(realpathSync(r));
    } catch {}
  }
  return [...new Set(roots)];
}

/** Lines from the start of a file, read in chunks. */
function* headLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let carry = "";
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      const parts = (carry + buf.subarray(0, n).toString("utf8")).split("\n");
      carry = parts.pop() ?? "";
      for (const p of parts) if (p) yield p;
    }
    if (carry) yield carry;
  } finally {
    closeSync(fd);
  }
}

/** The real path of `file` when it is a Pi session file under the session roots, else null. */
export function confineSessionFile(file: string, roots: string[]): string | null {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return null;
  }
  if (!real.endsWith(".jsonl")) return null;
  if (!roots.some((r) => inside(real, r))) return null;
  try {
    const st = statSync(real);
    if (!st.isFile() || st.nlink > 1) return null;
    for (const line of headLines(real)) {
      const header = JSON.parse(line) as { type?: unknown };
      return header?.type === "session" ? real : null;
    }
  } catch {
    return null;
  }
  return null;
}

function listSessionFiles(roots: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  return files;
}

// --- transcript rendering ----------------------------------------------------------------------

interface Entry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
  };
  summary?: string;
  customType?: string;
  content?: unknown;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more chars]`);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

const WS_RUNS_CMD = /(?:^|[;&|(]\s*)ws-runs(?:\s|$)/;

interface ToolCall {
  type?: string;
  id?: string;
  name?: string;
  arguments?: { command?: unknown };
}

function isWsRunsCall(c: ToolCall): boolean {
  return c?.type === "toolCall" && c.name === "bash" && typeof c.arguments?.command === "string" && WS_RUNS_CMD.test(c.arguments.command.trim());
}

/** Ids of the bash calls in `file` that ran ws-runs, whose output search skips. */
function wsRunsCallIds(file: string): Set<string> {
  const ids = new Set<string>();
  for (const line of headLines(file)) {
    if (!line.includes("ws-runs")) continue;
    const content = parseEntry(line)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as ToolCall[]) if (isWsRunsCall(c) && c.id) ids.add(c.id);
  }
  return ids;
}

function toolCallsOf(content: unknown, hideWsRuns: boolean): string[] {
  if (!Array.isArray(content)) return [];
  return (content as ToolCall[])
    .filter((c) => c?.type === "toolCall" && typeof c.name === "string" && !(hideWsRuns && isWsRunsCall(c)))
    .map((c) => `→ ${c.name} ${clip(oneLine(redact(JSON.stringify(c.arguments ?? {}))), TOOL_ARGS_MAX)}`);
}

/** Tool calls to leave out: search hides its own ws-runs invocations and their results. */
interface Hide {
  wsRunsCallIds: Set<string>;
}

/** The printable, redacted lines for one session entry; empty for entries with nothing to show. */
function renderEntry(entry: Entry, full: boolean, hide?: Hide): string[] {
  // Redacted before any clipping, so a cut can't leave a secret fragment too short to match.
  return renderRaw(entry, full, hide).map(redact);
}

function renderRaw(entry: Entry, full: boolean, hide?: Hide): string[] {
  if (entry.type === "message" && entry.message) {
    const m = entry.message;
    if (m.role === "user") return [`user: ${textOf(m.content)}`];
    if (m.role === "assistant") {
      const lines: string[] = [];
      const text = textOf(m.content).trim();
      if (text) lines.push(`assistant: ${text}`);
      lines.push(...toolCallsOf(m.content, !!hide));
      if (m.stopReason === "error" || m.stopReason === "aborted") lines.push(`[${m.stopReason}${m.errorMessage ? `: ${oneLine(publicAuthError(m.errorMessage))}` : ""}]`);
      return lines;
    }
    if (m.role === "toolResult") {
      if (hide && m.toolCallId && hide.wsRunsCallIds.has(m.toolCallId)) return [];
      const text = redact(textOf(m.content));
      return [`← ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}: ${full ? text : clip(oneLine(text), TOOL_RESULT_MAX)}`];
    }
    return [];
  }
  if (entry.type === "compaction" && entry.summary) {
    const summary = redact(entry.summary);
    return [`[compaction] ${full ? summary : clip(oneLine(summary), TOOL_RESULT_MAX)}`];
  }
  if (entry.type === "custom_message") return [`[${entry.customType ?? "custom"}] ${textOf(entry.content)}`];
  return [];
}

function parseEntry(line: string): Entry | null {
  try {
    const e = JSON.parse(line) as Entry;
    return e && typeof e === "object" ? e : null;
  } catch {
    return null;
  }
}

// --- commands ----------------------------------------------------------------------------------

interface Ctx {
  io: WsRunsIo;
  stateDir: string;
  agentDirs: string[];
  roots: string[];
  /** The run this invocation happens in, from the agent's bash env. */
  currentRunId: string | null;
}

function displayPath(file: string, agentDirs: string[]): string {
  for (const dir of agentDirs) {
    for (const d of [dir, safeRealpath(dir)]) {
      const rel = relative(d, file);
      if (!rel.startsWith("..")) return rel;
    }
  }
  return basename(file);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function fmtTime(iso: string | undefined): string {
  return iso ? iso.slice(0, 19).replace("T", " ") : "-";
}

function fmtDuration(r: RunRecord): string {
  if (!r.endedAt) return "-";
  const s = Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(r: RunRecord): string {
  if (!r.usage) return "-";
  return `${r.usage.inputTokens}/${r.usage.outputTokens}${r.usage.costUsd ? ` $${r.usage.costUsd.toFixed(4)}` : ""}${r.usage.model ? ` ${r.usage.model}` : ""}`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd());
}

function cmdList(ctx: Ctx, flags: Flags): number {
  const limit = flags.int("limit", 20);
  const agent = flags.str("agent");
  const parentFlag = flags.str("parent");
  // A bare --parent means the current run's children.
  const parent = parentFlag === "" ? (ctx.currentRunId ?? undefined) : parentFlag;
  if (parentFlag === "" && !parent) return fail(ctx.io, "--parent: no runId given and WS_RUN_ID is not set");
  const sinceRaw = flags.str("since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(since.getTime())) return fail(ctx.io, `--since: not a date: ${sinceRaw}`);
  const rows: string[][] = [["RUN", "STARTED (UTC)", "STATUS", "AGENT", "PARENT", "DUR", "TOK IN/OUT", "TASK"]];
  let n = 0;
  for (const r of latestRuns(runLogPath(ctx.stateDir))) {
    if (agent !== undefined && r.agentName !== agent) continue;
    if (parent !== undefined && r.parentRunId !== parent) continue;
    if (since && Date.parse(r.startedAt) < since.getTime()) continue;
    rows.push([r.runId, fmtTime(r.startedAt), r.status, r.agentName, r.parentRunId ?? "-", fmtDuration(r), fmtTokens(r), clip(oneLine(redact(r.task)), 60)]);
    if (++n >= limit) break;
  }
  if (ctx.currentRunId) ctx.io.out(redact(`current run: ${ctx.currentRunId}`));
  if (n === 0) {
    ctx.io.out("no runs recorded");
    return 0;
  }
  for (const line of table(rows)) ctx.io.out(redact(line));
  return 0;
}

function findRun(stateDir: string, runId: string): RunRecord | null {
  for (const r of latestRuns(runLogPath(stateDir))) if (r.runId === runId) return r;
  return null;
}

function cmdShow(ctx: Ctx, arg: string | undefined, flags: Flags): number {
  const runId = arg ?? ctx.currentRunId;
  if (!runId) return fail(ctx.io, USAGE);
  const full = flags.bool("full");
  const run = findRun(ctx.stateDir, runId);
  if (!run) return fail(ctx.io, `no run ${runId}`);
  const out = (s: string) => ctx.io.out(redact(s));
  out(`run:      ${run.runId}`);
  out(`agent:    ${run.agentName}${run.parentRunId ? ` (parent ${run.parentRunId})` : ""}`);
  out(`status:   ${run.status}`);
  out(`started:  ${run.startedAt}`);
  out(`ended:    ${run.endedAt ?? "-"} (${fmtDuration(run)})`);
  out(`tokens:   ${fmtTokens(run)}`);
  out(`session:  ${displayPath(run.sessionFile, ctx.agentDirs)}`);
  out(`task:     ${run.task}`);
  if (run.resultSummary) out(`result:   ${run.resultSummary}`);
  out("");

  const file = confineSessionFile(run.sessionFile, ctx.roots);
  if (!file) {
    out(existsSync(run.sessionFile) ? "(session file is outside the session dirs; not shown)" : "(no session file yet: the run ended before Pi wrote one)");
    return 0;
  }
  const from = Date.parse(run.startedAt);
  const to = run.endedAt ? Date.parse(run.endedAt) : Number.POSITIVE_INFINITY;
  let shown = 0;
  let first = true;
  for (const line of headLines(file)) {
    if (first) {
      first = false;
      continue;
    }
    const entry = parseEntry(line);
    if (!entry?.timestamp) continue;
    const t = Date.parse(entry.timestamp);
    if (t < from || t > to) continue;
    for (const l of renderEntry(entry, full)) {
      out(`[${fmtTime(entry.timestamp)}] ${l}`);
      shown++;
    }
  }
  if (shown === 0) out("(no transcript entries in this run's time range)");
  return 0;
}

function cmdSearch(ctx: Ctx, query: string | undefined, flags: Flags): number {
  if (!query) return fail(ctx.io, USAGE);
  const limit = flags.int("limit", 20);
  const roots = ctx.roots;
  const needle = query.toLowerCase();

  const runsByFile = new Map<string, RunRecord[]>();
  for (const r of latestRuns(runLogPath(ctx.stateDir))) {
    let key = r.sessionFile;
    try {
      key = realpathSync(r.sessionFile);
    } catch {}
    const list = runsByFile.get(key) ?? [];
    list.push(r);
    runsByFile.set(key, list);
  }
  const runAt = (file: string, ts: string | undefined): string => {
    const t = ts ? Date.parse(ts) : Number.NaN;
    const r = runsByFile.get(file)?.find((r) => t >= Date.parse(r.startedAt) && t <= (r.endedAt ? Date.parse(r.endedAt) : Number.POSITIVE_INFINITY));
    return r?.runId ?? "-";
  };

  const files = listSessionFiles(roots)
    .map((f) => confineSessionFile(f, roots))
    .filter((f): f is string => f !== null)
    .flatMap((f) => {
      try {
        return [{ f, mtime: statSync(f).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  let hits = 0;
  for (const { f } of files) {
    let hide: Hide | undefined;
    for (const line of tailLines(f)) {
      if (!line.toLowerCase().includes(needle)) continue;
      const entry = parseEntry(line);
      if (!entry || entry.type === "session") continue;
      hide ??= { wsRunsCallIds: wsRunsCallIds(f) };
      // Matched against redacted text, so hit/no-hit can't reveal a secret one guessed character at a time.
      const text = renderEntry(entry, true, hide).join(" ");
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - SNIPPET_RADIUS);
      const snippet = `${start > 0 ? "…" : ""}${oneLine(text.slice(start, at + needle.length + SNIPPET_RADIUS))}${at + needle.length + SNIPPET_RADIUS < text.length ? "…" : ""}`;
      ctx.io.out(redact(`${runAt(f, entry.timestamp)}  ${displayPath(f, ctx.agentDirs)}  ${fmtTime(entry.timestamp)}  ${snippet}`));
      if (++hits >= limit) return 0;
    }
  }
  if (hits === 0) ctx.io.out("no matches");
  return 0;
}

// --- argv ----------------------------------------------------------------------------------------

interface Flags {
  str(name: string): string | undefined;
  int(name: string, def: number): number;
  bool(name: string): boolean;
}

const BOOL_FLAGS = new Set(["full"]);

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (eq !== -1) values.set(name, a.slice(eq + 1));
    else if (BOOL_FLAGS.has(name)) values.set(name, "true");
    else if (argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) values.set(name, "");
    else values.set(name, argv[++i]!);
  }
  return {
    positional,
    flags: {
      str: (n) => values.get(n),
      int: (n, def) => {
        const v = Number.parseInt(values.get(n) ?? "", 10);
        return Number.isFinite(v) && v > 0 ? v : def;
      },
      bool: (n) => values.get(n) === "true",
    },
  };
}

function fail(io: WsRunsIo, msg: string): number {
  io.err(msg);
  return 1;
}

export function runWsRuns(argv: string[], io: WsRunsIo): number {
  const { positional, flags } = parseArgs(argv);
  const [cmd, arg] = positional;
  const stateDir = resolveStateDir(io.env);
  if (!stateDir) return fail(io, "cannot locate the run index (set HOME or WORKSPACE_STATE_DIR)");
  const agentDirs = io.agentDirs.map((d) => resolve(d));
  const currentRunId = io.env.WS_RUN_ID?.trim() || null;
  const ctx: Ctx = { io, stateDir, agentDirs, roots: realRoots(agentDirs), currentRunId };
  switch (cmd) {
    case "list":
      return cmdList(ctx, flags);
    case "show":
      return cmdShow(ctx, arg, flags);
    case "search":
      return cmdSearch(ctx, positional.slice(1).join(" ") || undefined, flags);
    default:
      return fail(io, USAGE);
  }
}
