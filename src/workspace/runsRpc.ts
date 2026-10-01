import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  DELIVER_FILES_MAX,
  ID_MAX,
  JOB_NAME_RE,
  RPC_METHODS,
  RUN_CHILDREN_MAX,
  RUN_ID_RE,
  RUN_STEP_LIMITS,
  runStep,
  runsChangedParams,
  runsGetParams,
  runsGetResult,
  runsListParams,
  runsListResult,
  type RunEvidence,
  type RunKind,
  type RunStep,
  type RunSummary,
  type RunsGetResult,
  type RunsListResult,
} from "../orchestration/contracts.ts";
import { RpcHandlerError } from "../orchestration/transport/client.ts";
import { publicAuthError } from "./chatgptFallback.ts";
import { localTime, runFileRel } from "./history.ts";
import { existingRunFile, historyRoot, historyRunSummary } from "./historyFiles.ts";
import { MEMORY_PATHS } from "./home.ts";
import { runLogPath, type RunRecord, type RunRecorder } from "./runLog.ts";
import { SLICE_SLACK, entriesInWindow, openSession, realRoots, runIdTime, runKindOf, safeText, scanRunIndex, textOf, toRunSummary, type Entry, type RunIndex } from "./runReader.ts";
import { SEND_FILE_TOOL } from "./sendFile.ts";
import { VERIFY_CUSTOM_TYPE, bashChangedRepo, bashMutates, isCheckCommand } from "./verifyGate.ts";

// runs/list and runs/get: the run index and each run's window of its session transcript, shaped for the
// Runs screens. All of it is the agent's own record (agent-writable), shown as such.

const str = (v: unknown): v is string => typeof v === "string";
const STAMP_MAX = 40;
/** Pi entry ids are short hex; anything else gets a positional id. */
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Commands are matched by regexes that backtrack on long input. */
const COMMAND_SCAN_MAX = 500;
/** A whole runs/get result, serialized, stays under this: the bot rejects anything over 2 MB. */
export const RUNS_GET_BUDGET = 1_400_000;
const CHECKS_MAX = 20;
const REPOS_MAX = 20;
const MEMORY_WRITES_MAX = 50;
const FILES_SENT_MAX = DELIVER_FILES_MAX * 5;

export interface RunsRpcOptions {
  principalId: string;
  stateDir: string;
  home: string;
  tz: string;
  /** The host's own agent dirs; session roots are derived from them on each call. */
  agentDirs: string[];
  now?: () => Date;
}

function checkPrincipal(expected: string, got: string): void {
  if (got !== expected) throw new Error(`principal mismatch: this workspace serves ${expected}, got ${got}`);
}

// --- runs/list ---------------------------------------------------------------------------------------

export async function runsList(opts: RunsRpcOptions, p: unknown): Promise<RunsListResult> {
  const params = runsListParams.parse(p);
  checkPrincipal(opts.principalId, params.principalId);
  const index = await scanRunIndex(runLogPath(opts.stateDir));
  const since = params.since ? Date.parse(params.since) : null;
  const until = params.until ? Date.parse(params.until) : null;
  // Cheap filters on the raw records first: only the page is redacted.
  const candidates = [...index.runs.values()]
    .filter((r) => {
      if (!RUN_ID_RE.test(r.runId) || (params.before && r.runId >= params.before)) return false;
      if (params.statuses && !(params.statuses as string[]).includes(r.status)) return false;
      if (params.kinds && !params.kinds.includes(runKindOf(r))) return false;
      const t = Date.parse(r.startedAt);
      if (since !== null && !(t >= since)) return false;
      if (until !== null && !(t < until)) return false;
      return true;
    })
    .sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  const runs: RunSummary[] = [];
  let i = 0;
  for (; i < candidates.length && runs.length < params.limit; i++) {
    const s = toRunSummary(candidates[i]!);
    if (s) runs.push(s);
  }
  return runsListResult.parse({ runs, before: i < candidates.length && runs.length ? runs.at(-1)!.runId : null, truncated: index.truncated });
}

// --- steps -----------------------------------------------------------------------------------------

interface ToolCallItem {
  type?: string;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

/** One tool call, cut at read time to what steps and evidence use. Strings are raw (not yet redacted). */
interface SlimCall {
  id?: string;
  name: string;
  argsJson: string;
  command?: string;
  path?: string;
  fileName?: string;
}

/** A session entry cut at read time: texts sliced just past their caps (so redaction still sees the cut), no image data. */
export interface SlimEntry {
  type: "user" | "assistant" | "toolResult" | "compaction" | "custom";
  id?: string;
  at: string;
  text: string;
  calls?: SlimCall[];
  stop?: { reason: "error" | "aborted"; message: string };
  toolCallId?: string;
  isError?: boolean;
  childRunId?: string;
  customType?: string;
}

const isStamp = (v: unknown): v is string => str(v) && v.length <= STAMP_MAX && !Number.isNaN(Date.parse(v));
/** Long enough that `safeText` still knows the text was cut. */
const head = (s: string, max: number) => (s.length > max + SLICE_SLACK ? s.slice(0, max + SLICE_SLACK + 1) : s);
const PATH_MAX = 4_096;

function slimCall(c: ToolCallItem): SlimCall {
  const args = c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments) ? (c.arguments as Record<string, unknown>) : {};
  let argsJson = "";
  try {
    argsJson = JSON.stringify(c.arguments ?? {}) ?? "";
  } catch {}
  return {
    ...(str(c.id) ? { id: c.id.slice(0, ID_MAX) } : {}),
    name: head(c.name as string, ID_MAX),
    argsJson: head(argsJson, RUN_STEP_LIMITS.toolArgs),
    ...(str(args.command) ? { command: args.command.slice(0, COMMAND_SCAN_MAX) } : {}),
    ...(str(args.path) ? { path: args.path.slice(0, PATH_MAX) } : {}),
    ...(str(args.name) ? { fileName: head(args.name, ID_MAX) } : {}),
  };
}

/** The parts of a session entry a run detail shows, or null for entries it skips. */
export function slimEntry(e: Entry): SlimEntry | null {
  if (!isStamp(e.timestamp)) return null;
  const base = { at: e.timestamp, ...(str(e.id) ? { id: e.id.slice(0, 128) } : {}) };
  const m = e.message;
  if (e.type === "message" && m?.role === "user") return { ...base, type: "user", text: head(textOf(m.content), RUN_STEP_LIMITS.user) };
  if (e.type === "message" && m?.role === "assistant") {
    const calls = Array.isArray(m.content) ? (m.content as ToolCallItem[]).filter((c) => c?.type === "toolCall" && str(c.name)).map(slimCall) : [];
    const stop = m.stopReason === "error" || m.stopReason === "aborted" ? { reason: m.stopReason as "error" | "aborted", message: str(m.errorMessage) ? m.errorMessage.slice(0, 4_000) : "" } : undefined;
    return { ...base, type: "assistant", text: head(textOf(m.content).trim(), RUN_STEP_LIMITS.assistant), calls, ...(stop ? { stop } : {}) };
  }
  if (e.type === "message" && m?.role === "toolResult" && str(m.toolCallId)) {
    const child = (m.details as { runId?: unknown } | undefined)?.runId;
    return {
      ...base,
      type: "toolResult",
      text: head(textOf(m.content), RUN_STEP_LIMITS.toolResult),
      toolCallId: m.toolCallId.slice(0, ID_MAX),
      isError: m.isError === true,
      ...(str(child) && RUN_ID_RE.test(child) ? { childRunId: child } : {}),
    };
  }
  if (e.type === "compaction" && str(e.summary)) return { ...base, type: "compaction", text: head(e.summary, RUN_STEP_LIMITS.note) };
  if (e.type === "custom_message") {
    return { ...base, type: "custom", text: head(textOf(e.content), RUN_STEP_LIMITS.note), ...(str(e.customType) ? { customType: e.customType.slice(0, 64) } : {}) };
  }
  return null;
}

/** One tool call as evidence sees it. */
export interface ToolUse {
  call: SlimCall;
  ok: boolean | null;
  at: string;
}

/** A step whose id and place are fixed; its redacted text is built only when a page includes it. */
export interface PendingStep {
  id: string;
  render: () => RunStep;
}

export interface BuiltSteps {
  steps: PendingStep[];
  uses: ToolUse[];
  verifyNudged: boolean;
}

/** The steps of a run's window, in file order. Ids are stable while the run appends: positional ones count from the window start. */
export function buildSteps(entries: SlimEntry[]): BuiltSteps {
  const results = new Map<string, SlimEntry>();
  for (const e of entries) if (e.type === "toolResult" && e.toolCallId && !results.has(e.toolCallId)) results.set(e.toolCallId, e);
  const used = new Set<string>();
  const steps: PendingStep[] = [];
  const uses: ToolUse[] = [];
  let verifyNudged = false;
  const add = (id: string, render: () => RunStep) => steps.push({ id, render });
  entries.forEach((e, i) => {
    if (e.type === "toolResult") return;
    const at = e.at;
    const id = e.id && ENTRY_ID.test(e.id) && !used.has(e.id) ? e.id : `#${i}`;
    used.add(id);
    if (e.type === "user") {
      add(id, () => ({ type: "user", id, at, text: safeText(e.text, RUN_STEP_LIMITS.user) }));
    } else if (e.type === "assistant") {
      if (e.text) add(id, () => ({ type: "assistant", id, at, text: safeText(e.text, RUN_STEP_LIMITS.assistant) }));
      (e.calls ?? []).forEach((c, k) => {
        const result = c.id ? results.get(c.id) : undefined;
        const ok = result ? !result.isError : null;
        uses.push({ call: c, ok, at });
        add(`${id}/t${k}`, () => {
          const duration = result ? Date.parse(result.at) - Date.parse(at) : Number.NaN;
          return {
            type: "tool",
            id: `${id}/t${k}`,
            at,
            name: safeText(c.name, ID_MAX, { oneLine: true }),
            args: safeText(c.argsJson, RUN_STEP_LIMITS.toolArgs, { oneLine: true }),
            ok,
            result: result ? safeText(result.text, RUN_STEP_LIMITS.toolResult) : "",
            ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: Math.round(duration) } : {}),
            ...(result?.childRunId ? { agentId: result.childRunId } : {}),
          };
        });
      });
      const stop = e.stop;
      if (stop) {
        add(`${id}/stop`, () => ({
          type: "note",
          id: `${id}/stop`,
          at,
          kind: stop.reason,
          text: safeText(stop.message ? publicAuthError(stop.message) : stop.reason, RUN_STEP_LIMITS.note, { oneLine: true }),
        }));
      }
    } else if (e.type === "compaction") {
      add(id, () => ({ type: "note", id, at, kind: "compaction", text: safeText(e.text, RUN_STEP_LIMITS.note) }));
    } else {
      const verify = e.customType === VERIFY_CUSTOM_TYPE;
      if (verify) verifyNudged = true;
      const label = e.customType && !verify ? `[${e.customType}] ` : "";
      add(id, () => ({ type: "note", id, at, kind: verify ? "verify" : "custom", text: safeText(label + e.text, RUN_STEP_LIMITS.note) }));
    }
  });
  return { steps, uses, verifyNudged };
}

// --- evidence --------------------------------------------------------------------------------------

/** `path` relative to home when it resolves inside it (the main session's cwd is home), else null. */
function homeRelative(path: string, home: string): string | null {
  let p = path.startsWith("@") ? path.slice(1) : path;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  const rel = relative(home, resolve(home, p));
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

const isMemoryRel = (rel: string) => MEMORY_PATHS.some((m) => (m.endsWith("/") ? rel.startsWith(m) : rel === m));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MEMORY_IN_BASH = new RegExp(`(?:^|[\\s"'=/~(])(${MEMORY_PATHS.map(escape).join("|")})`);
/** Tool uses examined between yields to the event loop. */
const EVIDENCE_SLICE = 100;

export async function buildEvidence(uses: ToolUse[], verifyNudged: boolean, home: string): Promise<RunEvidence> {
  const checks: { command: string; ok: boolean | null; at: string }[] = [];
  const repos = new Set<string>();
  const filesSent: { name: string; at: string }[] = [];
  const memoryWrites: { path: string; tool: "write" | "edit" | "bash"; at: string }[] = [];
  let changed = false;
  let unverified = false;
  const change = (repo: string) => {
    if (repos.size < REPOS_MAX) repos.add(repo.slice(0, 200));
    changed = true;
    unverified = true;
  };
  for (let i = 0; i < uses.length; i++) {
    if (i > 0 && i % EVIDENCE_SLICE === 0) await new Promise<void>((r) => setImmediate(r));
    const { call, ok, at } = uses[i]!;
    if (call.name === "bash" && call.command !== undefined) {
      const cmd = call.command;
      const repo = bashChangedRepo(cmd);
      if (repo) change(repo);
      const mem = memoryWrites.length < MEMORY_WRITES_MAX && bashMutates(cmd) ? MEMORY_IN_BASH.exec(cmd)?.[1] : undefined;
      if (mem) memoryWrites.push({ path: mem, tool: "bash", at });
      // A failing check still counts, as in the verify gate: the agent saw the result.
      if (isCheckCommand(cmd)) {
        checks.push({ command: cmd, ok, at });
        if (checks.length > CHECKS_MAX) checks.shift();
        unverified = false;
      }
    } else if ((call.name === "edit" || call.name === "write") && call.path && ok !== false) {
      const rel = homeRelative(call.path, home);
      if (!rel) continue;
      const parts = rel.split("/");
      if (parts[0] === "projects" && parts[1]) change(parts[1]);
      if (memoryWrites.length < MEMORY_WRITES_MAX && isMemoryRel(rel)) memoryWrites.push({ path: rel, tool: call.name, at });
    } else if (call.name === SEND_FILE_TOOL && call.path && ok === true && filesSent.length < FILES_SENT_MAX) {
      filesSent.push({ name: call.fileName?.trim() || basename(call.path), at });
    }
  }
  return {
    checks: checks.map((c) => ({ ...c, command: safeText(c.command, 200, { oneLine: true }) })),
    changedRepos: [...repos].map((r) => safeText(r, 100, { oneLine: true })),
    checkAfterLastChange: changed ? !unverified : null,
    verifyNudged,
    filesSent: filesSent.map((f) => ({ ...f, name: safeText(f.name, ID_MAX, { oneLine: true }) })),
    memoryWrites: memoryWrites.map((w) => ({ ...w, path: safeText(w.path, 300, { oneLine: true }) })),
  };
}

// --- runs/get ----------------------------------------------------------------------------------------

function childrenOf(index: RunIndex, runId: string): RunSummary[] {
  const out: RunSummary[] = [];
  const ids = [...index.runs.values()].filter((r) => r.parentRunId === runId).sort((a, b) => (a.runId < b.runId ? -1 : 1));
  for (const r of ids) {
    const s = toRunSummary(r);
    if (s) out.push(s);
    if (out.length >= RUN_CHILDREN_MAX) break;
  }
  return out;
}

/** A run past the index window, from its history file: the day of its id's timestamp, or the day before. */
async function fromHistory(opts: RunsRpcOptions, root: string, runId: string): Promise<{ run: RunSummary; rel: string } | null> {
  const at = runIdTime(runId);
  if (!at) return null;
  const tried = new Set<string>();
  for (const d of [at, new Date(at.getTime() - 24 * 3600_000)]) {
    const t = localTime(d, opts.tz);
    const rel = `${t.month}/${t.day}-${runId}.md`;
    if (tried.has(rel)) continue;
    tried.add(rel);
    const run = await historyRunSummary(root, rel, runId);
    if (run) return { run, rel };
  }
  return null;
}

function page(steps: PendingStep[], after: string | undefined, limit: number, budget: number): { steps: RunStep[]; after: string | null } {
  let start = 0;
  if (after !== undefined) {
    const at = steps.findIndex((s) => s.id === after);
    if (at === -1) throw new RpcHandlerError("unknown steps cursor", -32602);
    start = at + 1;
  }
  const out: RunStep[] = [];
  let bytes = 0;
  let i = start;
  for (; i < steps.length && out.length < limit; i++) {
    const step = steps[i]!.render();
    if (!runStep.safeParse(step).success) continue;
    const size = Buffer.byteLength(JSON.stringify(step)) + 1;
    if (out.length && bytes + size > budget) break;
    bytes += size;
    out.push(step);
  }
  return { steps: out, after: i < steps.length && out.length ? out.at(-1)!.id : null };
}

export async function runsGet(opts: RunsRpcOptions, p: unknown): Promise<RunsGetResult> {
  const params = runsGetParams.parse(p);
  checkPrincipal(opts.principalId, params.principalId);
  const index = await scanRunIndex(runLogPath(opts.stateDir));
  const root = await historyRoot(opts.home);
  const rec: RunRecord | undefined = index.runs.get(params.runId);
  if (!rec) {
    const found = root ? await fromHistory(opts, root, params.runId) : null;
    if (!found) return { found: false };
    if (params.after !== undefined) throw new RpcHandlerError("unknown steps cursor", -32602);
    return runsGetResult.parse({
      found: true,
      run: found.run,
      children: childrenOf(index, params.runId),
      session: "missing",
      steps: [],
      after: null,
      historyFile: found.rel,
    });
  }
  const run = toRunSummary(rec);
  if (!run) return { found: false };
  const parentRec = run.parentRunId ? index.runs.get(run.parentRunId) : undefined;
  const parent = parentRec ? toRunSummary(parentRec) : null;

  const session = await openSession(rec.sessionFile, realRoots(opts.agentDirs));
  let built: BuiltSteps = { steps: [], uses: [], verifyNudged: false };
  if (session.state === "ok") {
    try {
      const from = Date.parse(run.startedAt);
      const to = run.endedAt ? Date.parse(run.endedAt) : (opts.now?.() ?? new Date()).getTime();
      const read = await entriesInWindow(session, from, Number.isNaN(to) ? Number.POSITIVE_INFINITY : to, slimEntry);
      built = buildSteps(read.entries);
      if (read.truncated) {
        const note: RunStep = { type: "note", id: "#head", at: run.startedAt, kind: "custom", text: "The start of this run is past the transcript read limit and isn't shown." };
        built.steps.unshift({ id: note.id, render: () => note });
      }
    } finally {
      await session.fh.close();
    }
  }
  const startedAt = new Date(run.startedAt);
  const rel = Number.isNaN(startedAt.getTime()) ? null : runFileRel(run.runId, startedAt, opts.tz);
  const historyFile = root && rel && (await existingRunFile(root, rel)) ? rel : undefined;
  const rest = {
    found: true as const,
    run,
    ...(parent ? { parent } : {}),
    children: childrenOf(index, run.runId),
    session: session.state,
    ...(params.after === undefined ? { evidence: await buildEvidence(built.uses, built.verifyNudged, opts.home) } : {}),
    ...(historyFile ? { historyFile } : {}),
  };
  const budget = RUNS_GET_BUDGET - Buffer.byteLength(JSON.stringify({ ...rest, steps: [], after: "x".repeat(ID_MAX) }));
  const { steps, after } = page(built.steps, params.after, params.limit, budget);
  return runsGetResult.parse({ ...rest, steps, after });
}

export function runsHandlers(opts: RunsRpcOptions): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [RPC_METHODS.runsList]: (p) => runsList(opts, p),
    [RPC_METHODS.runsGet]: (p) => runsGet(opts, p),
  };
}

// --- runs/changed ------------------------------------------------------------------------------------

/** Kinds Home shows as background work; a chat turn is already live on the bot's own stream. */
const NOTIFIED_KINDS: ReadonlySet<RunKind> = new Set(["job", "subagent", "agent"]);
const OPEN_MAX = 2_000;

/**
 * Wraps the host's one run recorder so a background run's start and end reach the bot as a `runs/changed`
 * notification. Fire-and-forget: a closed link or a bad shape never fails the run log write.
 */
export function notifyRunChanges(inner: RunRecorder, notify: (method: string, params: unknown) => void, principalId: string, log?: { warn: (obj: object, msg: string) => void }): RunRecorder {
  const open = new Map<string, { kind: RunKind; parentRunId?: string; jobName?: string }>();
  const send = (runId: string, info: { kind: RunKind; parentRunId?: string; jobName?: string }, status: RunRecord["status"]) => {
    try {
      const params = runsChangedParams.safeParse({ principalId, runId, kind: info.kind, status, ...(info.parentRunId ? { parentRunId: info.parentRunId } : {}), ...(info.jobName ? { jobName: info.jobName } : {}) });
      if (params.success) notify(RPC_METHODS.runsChanged, params.data);
    } catch (err) {
      log?.warn({ err, runId }, "failed to send runs/changed");
    }
  };
  return {
    startRun(input) {
      const runId = inner.startRun(input);
      const kind = runKindOf(input);
      if (NOTIFIED_KINDS.has(kind)) {
        const jobName = kind === "job" ? input.agentName.slice(4) : undefined;
        const info = { kind, ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}), ...(jobName && JOB_NAME_RE.test(jobName) ? { jobName } : {}) };
        open.set(runId, info);
        if (open.size > OPEN_MAX) open.delete(open.keys().next().value!);
        send(runId, info, "running");
      }
      return runId;
    },
    endRun(runId, end) {
      inner.endRun(runId, end);
      const info = open.get(runId);
      open.delete(runId);
      if (info) send(runId, info, end.status);
    },
    listRuns: (q) => inner.listRuns(q),
    getRun: (runId) => inner.getRun(runId),
  };
}
