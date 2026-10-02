import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { type EndRunInput, type ListRunsQuery, type RunRecord, type RunRecorder, type RunStatus, type StartRunInput } from "./runLog.ts";
import { publicAuthError } from "./chatgptFallback.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { redact } from "./secretPatterns.ts";
import { SESSION_READ_MAX_BYTES, openConfinedSessionSync, parseEntry, realRoots, tailLinesOfSync, textOf, type Entry } from "./runReader.ts";

// Plain-markdown history under $HOME/history, for the agent to read with rg/cat. Written by the host
// after every run and at the end of every chat session; never versioned (the home .gitignore is an allowlist).

export const HISTORY_DIR = "history";
const TOOL_ARGS_MAX = 120;
const TOOL_HINT_MAX = 60;
const TOPIC_MAX = 80;
const CUSTOM_MAX = 300;
/** Agent names whose runs are bookkeeping with no transcript of their own. */
const SKIPPED_AGENTS = new Set(["main:rotate"]);
const RUNS_HEADING = "## Runs";
const SESSIONS_HEADING = "## Sessions";
const KNOWN_MAX = 2000;
const TEXT_MAX = 16_000;
const ERROR_SOURCE_MAX = 4_000;
const REDACT_MARGIN = 200;
const REDACT_GROW_LIMIT = 8_000;
/** The slice end can cut through a secret whose prefix matches no pattern; drop the whole token run it ends in. */
const TOKEN_TAIL = /[\w.+/=-]+$/;

type Log = { warn: (obj: object, msg: string) => void };

export interface HistoryOptions {
  home: string;
  /** The trusted agent dir; transcripts are only read from its session roots. */
  agentDir: string;
  tz: string;
  now?: () => Date;
}

export type SessionEndReason = "rotate" | "new" | "compaction";

export interface SessionSummary {
  reason: SessionEndReason;
  sessionFile: string;
  text: string;
  at?: Date;
}

/** What the writer needs to know about one finished run; everything but the session file is display only. */
export interface FinishedRun {
  runId: string;
  agentName: string;
  parentRunId?: string;
  parentStartedAt?: Date;
  task: string;
  sessionFile: string;
  startedAt: Date;
  /** Lower bound of the transcript window; defaults to startedAt. Catches entries appended while idle. */
  windowFrom?: Date;
  endedAt: Date;
  status: RunStatus;
  usage?: RunRecord["usage"];
  resultSummary?: string;
  children: { runId: string; agentName: string; startedAt: Date; status: RunStatus }[];
}

interface LocalTime {
  date: string;
  month: string;
  day: string;
  time: string;
}

export function localTime(d: Date, tz: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const [y, m, day] = [get("year"), get("month"), get("day")];
  return { date: `${y}-${m}-${day}`, month: `${y}-${m}`, day, time: `${get("hour")}:${get("minute")}` };
}

/** A run's file, relative to the history dir. */
export function runFileRel(runId: string, startedAt: Date, tz: string): string {
  const t = localTime(startedAt, tz);
  return `${t.month}/${t.day}-${runId}.md`;
}

export function dailyFileRel(at: Date, tz: string): string {
  return `${localTime(at, tz).date}.md`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// Some secret patterns are quadratic on long runs, so only the head that can show is redacted. A match
// shrinks and pulls later text forward, so the slice grows until the cut lands well past what shows.
function redactHead(s: string, max: number): string {
  for (let len = max + REDACT_MARGIN; ; len *= 4) {
    if (s.length <= len) return redact(s);
    const out = redact(s.slice(0, len)).replace(TOKEN_TAIL, "");
    if (out.length >= max || len * 4 > REDACT_GROW_LIMIT) return out;
  }
}

const safeLine = (s: string, max: number) => clip(redactHead(oneLine(s), max), max);

function safeText(s: string): string {
  if (s.length <= TEXT_MAX) return redact(s);
  return `${redactHead(s, TEXT_MAX).slice(0, TEXT_MAX)}… _[truncated; ${s.length} chars in all]_`;
}

const isFlush = (text: string | null | undefined) => !!text?.startsWith(FLUSH_MARKER);

function kindOf(run: Pick<FinishedRun, "agentName" | "parentRunId">, flush = false): string {
  if ((run.agentName === "main" || run.agentName.startsWith("topic:"))) return flush ? "flush" : "chat";
  if (run.agentName.startsWith("job:")) return "job";
  return run.parentRunId ? "subagent" : "agent";
}

/** `[discord:123 2026-…]` → `discord:123`; the bracketed stamp every chat message starts with. */
function headerOrigin(text: string): string | null {
  const m = /^\[([^\s\]]+)(?:\s[^\]]*)?\]/.exec(text);
  return m && m[1]!.includes(":") ? m[1]! : null;
}

function stripHeader(text: string): string {
  return text.replace(/^\[[^\]\n]*\]\n?/, "");
}

interface ToolCallItem {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface ToolResult {
  isError: boolean;
  text: string;
}

/** The entries of the open session stamped within [from, to], oldest first; reads from the tail and stops at `from`. */
function entriesInWindow(session: { fd: number; size: number }, from: number, to: number): Entry[] {
  const out: Entry[] = [];
  for (const line of tailLinesOfSync(session.fd, session.size, { maxBytes: SESSION_READ_MAX_BYTES, maxLine: 16 * 1024 * 1024 }, { truncated: false })) {
    const entry = parseEntry(line);
    if (!entry?.timestamp || entry.type === "session") continue;
    const t = Date.parse(entry.timestamp);
    if (t < from) break;
    if (t <= to) out.push(entry);
  }
  return out.reverse();
}

function resultHint(r: ToolResult | undefined): string {
  if (!r) return "no result";
  const first = r.text.split("\n").find((l) => l.trim()) ?? "";
  const hint = first ? `: ${safeLine(first, TOOL_HINT_MAX)}` : "";
  return `${r.isError ? "error" : "ok"}${hint}`;
}

export interface Transcript {
  lines: string[];
  toolCount: number;
  firstUserText: string | null;
}

export function renderTranscript(entries: Entry[], tz: string): Transcript {
  const results = new Map<string, ToolResult>();
  for (const e of entries) {
    const m = e.message;
    if (e.type === "message" && m?.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, { isError: m.isError === true, text: textOf(m.content) });
  }
  const lines: string[] = [];
  let toolCount = 0;
  let firstUserText: string | null = null;
  const at = (e: Entry) => (e.timestamp ? ` · ${localTime(new Date(e.timestamp), tz).time}` : "");
  for (const e of entries) {
    const m = e.message;
    if (e.type === "message" && m?.role === "user") {
      const text = textOf(m.content);
      firstUserText ??= text;
      lines.push(`### user${at(e)}`, "", safeText(text).trim(), "");
    } else if (e.type === "message" && m?.role === "assistant") {
      const text = textOf(m.content).trim();
      const calls = Array.isArray(m.content) ? (m.content as ToolCallItem[]).filter((c) => c?.type === "toolCall" && typeof c.name === "string") : [];
      const error = m.stopReason === "error" || m.stopReason === "aborted" ? `_[${m.stopReason}${m.errorMessage ? `: ${safeLine(publicAuthError(m.errorMessage.slice(0, ERROR_SOURCE_MAX)), 200)}` : ""}]_` : null;
      if (!text && !calls.length && !error) continue;
      lines.push(`### assistant${at(e)}`, "");
      if (text) lines.push(safeText(text), "");
      for (const c of calls) {
        toolCount++;
        lines.push(`- \`${c.name}\` ${safeLine(JSON.stringify(c.arguments ?? {}), TOOL_ARGS_MAX)} → ${resultHint(c.id ? results.get(c.id) : undefined)}`);
      }
      if (calls.length) lines.push("");
      if (error) lines.push(error, "");
    } else if (e.type === "custom_message") {
      lines.push(`_[${e.customType ?? "custom"}${at(e)}] ${safeLine(textOf(e.content), CUSTOM_MAX)}_`, "");
    } else if (e.type === "compaction" && e.summary) {
      lines.push(`_[compaction${at(e)}] ${safeLine(e.summary, CUSTOM_MAX)}_`, "");
    }
  }
  return { lines, toolCount, firstUserText };
}

function fmtUsage(run: FinishedRun): string {
  const u = run.usage;
  const model = u?.model ?? "-";
  if (!u) return model;
  return `${model} · ${u.inputTokens} in / ${u.outputTokens} out${u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : ""}`;
}

/** A recap's own headings, pushed below the `### <session>` heading it sits under. */
function demoteHeadings(text: string): string {
  return text.replace(/^(#{1,6})(\s)/gm, (_m, hashes: string, sp: string) => `${"#".repeat(Math.min(6, hashes.length + 2))}${sp}`);
}

/** The first line under `## Goals` in an anchored recap, else its first content line. */
export function summaryTopic(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const goals = lines.findIndex((l) => /^#+\s*goals/i.test(l));
  const pick = (from: number) => lines.slice(from).find((l) => l && !l.startsWith("#") && !/^[-*]?\s*\(none\)$/i.test(l));
  const line = (goals >= 0 ? pick(goals + 1) : undefined) ?? pick(0) ?? "(no topic)";
  return line.replace(/^[-*]\s+/, "");
}

export class HistoryWriter {
  readonly dir: string;
  private readonly now: () => Date;

  constructor(private readonly opts: HistoryOptions) {
    this.dir = join(opts.home, HISTORY_DIR);
    this.now = opts.now ?? (() => new Date());
  }

  /** Writes the run's file and its daily index line. Throws on failure; `recordHistory` swallows. */
  writeRun(run: FinishedRun): string {
    const tz = this.opts.tz;
    const rel = runFileRel(run.runId, run.startedAt, tz);
    const file = join(this.dir, rel);
    // Read through the fd that passed the checks: a path re-opened later could have been swapped for a FIFO.
    const session = openConfinedSessionSync(run.sessionFile, realRoots([this.opts.agentDir]));
    let transcript: Transcript | null = null;
    if (session) {
      try {
        transcript = renderTranscript(entriesInWindow(session, (run.windowFrom ?? run.startedAt).getTime(), run.endedAt.getTime()), tz);
      } finally {
        closeSync(session.fd);
      }
    }
    const start = localTime(run.startedAt, tz);
    const end = localTime(run.endedAt, tz);
    const origin = transcript?.firstUserText ? headerOrigin(transcript.firstUserText) : null;
    const flush = (run.agentName === "main" || run.agentName.startsWith("topic:")) && isFlush(transcript?.firstUserText ?? run.task);
    const kind = kindOf(run, flush);
    const link = (runId: string, startedAt: Date) => relative(dirname(file), join(this.dir, runFileRel(runId, startedAt, tz)));

    const out = [`# ${kind} run ${run.runId}`, ""];
    out.push(`- **When:** ${start.date} ${start.time} → ${end.date === start.date ? "" : `${end.date} `}${end.time} (${tz})`);
    out.push(`- **Agent:** ${kind} / ${run.agentName}`);
    if (origin) out.push(`- **Origin:** ${safeLine(origin, TOPIC_MAX)}`);
    out.push(`- **Model:** ${fmtUsage(run)}`);
    out.push(`- **Status:** ${run.status}`);
    if (run.parentRunId) {
      out.push(`- **Parent:** ${run.parentStartedAt ? `[${run.parentRunId}](${link(run.parentRunId, run.parentStartedAt)})` : run.parentRunId}`);
    }
    for (const c of run.children) out.push(`- **Subagent:** [${c.agentName} ${c.runId}](${link(c.runId, c.startedAt)}) (${c.status})`);
    if (run.resultSummary && run.status !== "done") out.push(`- **Result:** ${safeLine(run.resultSummary, 300)}`);
    out.push("", "## Transcript", "");
    if (!transcript) out.push("_(no session file for this run)_");
    else if (!transcript.lines.length) out.push("_(no transcript entries in this run's time range)_");
    else out.push(...transcript.lines);

    this.ensureDir(this.dir);
    this.ensureDir(dirname(file));
    replaceFile(file, `${out.join("\n").trimEnd()}\n`);

    const topic = flush ? "memory flush" : safeLine(stripHeader(transcript?.firstUserText ?? run.task), TOPIC_MAX) || "(no message)";
    const tools = transcript?.toolCount ?? 0;
    const agent = (run.agentName === "main" || run.agentName.startsWith("topic:")) ? kind : `${kind}/${run.agentName}`;
    this.appendDaily(run.startedAt, RUNS_HEADING, `- ${start.time} ${agent} — ${topic} (${tools} tool${tools === 1 ? "" : "s"}, ${run.status}) [${run.runId}](${rel})`);
    return file;
  }

  /** Appends a session summary to the daily index of the day it happened. */
  writeSession(s: SessionSummary): void {
    const at = s.at ?? this.now();
    const text = safeText(s.text).trim();
    if (!text) return;
    const heading = `### ${localTime(at, this.opts.tz).time} · ${s.reason} · ${safeLine(summaryTopic(text), TOPIC_MAX)} · \`${basename(s.sessionFile)}\``;
    this.appendDaily(at, SESSIONS_HEADING, `${heading}\n\n${demoteHeadings(text)}`);
  }

  // A read-modify-rename keeps both sections in order; the file is small.
  private appendDaily(at: Date, section: typeof RUNS_HEADING | typeof SESSIONS_HEADING, block: string): void {
    const file = join(this.dir, dailyFileRel(at, this.opts.tz));
    this.ensureDir(this.dir);
    const current = readOwnFile(file) ?? `# ${localTime(at, this.opts.tz).date}\n\n${RUNS_HEADING}\n\n${SESSIONS_HEADING}\n`;
    const marker = `\n${SESSIONS_HEADING}\n`;
    const split = current.indexOf(marker);
    let next: string;
    if (split === -1) {
      next = section === RUNS_HEADING ? `${current.trimEnd()}\n${block}\n` : `${current.trimEnd()}\n\n${SESSIONS_HEADING}\n\n${block}\n`;
    } else if (section === RUNS_HEADING) {
      const head = current.slice(0, split).trimEnd();
      next = `${head}${head.endsWith(RUNS_HEADING) ? "\n\n" : "\n"}${block}\n${current.slice(split)}`;
    } else {
      next = `${current.trimEnd()}\n\n${block}\n`;
    }
    replaceFile(file, next);
  }

  private ensureDir(dir: string): void {
    try {
      assertPlainDir(dir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    mkdirSync(dir);
  }
}

function assertPlainDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
}

// ~/history is agent-writable: reads refuse links and non-regular files (null = replace it), writes rename
// a fresh file over the entry, and any other read error throws so a transient one can't wipe the file.
function readOwnFile(file: string): string | null {
  let fd: number;
  try {
    // O_NONBLOCK: opening a planted FIFO would otherwise block the whole host until a writer shows up.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP is a symlink under O_NOFOLLOW; ENXIO a socket.
    if (code === "ENOENT" || code === "ELOOP" || code === "ENXIO") return null;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.nlink === 1 ? readFileSync(fd, "utf8") : null;
  } finally {
    closeSync(fd);
  }
}

function replaceFile(file: string, content: string): void {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { flag: "wx" });
  try {
    assertPlainDir(dirname(file));
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Wraps `inner` so every run that ends also lands in $HOME/history. The session file and times come from
 * the host's own startRun calls, never from runs.jsonl, which the agent can write. History failures are
 * logged and swallowed; the run log itself behaves exactly as before.
 */
export function recordHistory(inner: RunRecorder, writer: HistoryWriter, log: Log, now: () => Date = () => new Date()): RunRecorder {
  const open = new Map<string, StartRunInput & { at: Date }>();
  const bootedAt = now();
  // Runs on one session file are sequential, so everything since the previous run's end belongs to this
  // one: channel context and a seeded recap are appended while the session sits idle.
  const lastEnd = new Map<string, Date>();
  // Kept past a run's end: a background child can outlive its parent and still links back to it.
  const known = new Map<string, { agentName: string; at: Date; parentRunId?: string; status: RunStatus }>();
  const remember = (runId: string, info: { agentName: string; at: Date; parentRunId?: string; status: RunStatus }) => {
    known.delete(runId);
    known.set(runId, info);
    if (known.size > KNOWN_MAX) known.delete(known.keys().next().value!);
  };
  return {
    startRun(input) {
      const at = input.startedAt ?? now();
      const runId = inner.startRun(input);
      open.set(runId, { ...input, at });
      remember(runId, { agentName: input.agentName, at, ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}), status: "running" });
      return runId;
    },
    endRun(runId: string, end: EndRunInput) {
      inner.endRun(runId, end);
      const start = open.get(runId);
      open.delete(runId);
      if (!start) return;
      remember(runId, { agentName: start.agentName, at: start.at, ...(start.parentRunId ? { parentRunId: start.parentRunId } : {}), status: end.status });
      if (SKIPPED_AGENTS.has(start.agentName)) return;
      const endedAt = now();
      const previous = lastEnd.get(start.sessionFile) ?? bootedAt;
      lastEnd.delete(start.sessionFile);
      lastEnd.set(start.sessionFile, endedAt);
      if (lastEnd.size > KNOWN_MAX) lastEnd.delete(lastEnd.keys().next().value!);
      try {
        const parentStartedAt = start.parentRunId ? known.get(start.parentRunId)?.at : undefined;
        const children = [...known].filter(([, k]) => k.parentRunId === runId).map(([id, k]) => ({ runId: id, agentName: k.agentName, startedAt: k.at, status: k.status }));
        writer.writeRun({
          runId,
          agentName: start.agentName,
          ...(start.parentRunId ? { parentRunId: start.parentRunId } : {}),
          ...(parentStartedAt ? { parentStartedAt } : {}),
          task: start.task,
          sessionFile: start.sessionFile,
          startedAt: start.at,
          windowFrom: previous < start.at ? previous : start.at,
          endedAt,
          status: end.status,
          ...(end.usage ? { usage: end.usage } : {}),
          ...(end.resultSummary ? { resultSummary: end.resultSummary } : {}),
          children,
        });
      } catch (err) {
        log.warn({ err, runId }, "failed to write the run's history file");
      }
    },
    listRuns: (query?: ListRunsQuery) => inner.listRuns(query),
    getRun: (runId: string) => inner.getRun(runId),
  };
}
