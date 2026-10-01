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
import { entriesInWindow, openSession, realRoots, runIdTime, runKindOf, safeText, scanRunIndex, textOf, toRunSummary, type Entry, type RunIndex } from "./runReader.ts";
import { SEND_FILE_TOOL } from "./sendFile.ts";
import { VERIFY_CUSTOM_TYPE, bashChangedRepo, bashMutates, isCheckCommand } from "./verifyGate.ts";

// runs/list and runs/get: the run index and each run's window of its session transcript, shaped for the
// Runs screens. All of it is the agent's own record (agent-writable), shown as such.

const str = (v: unknown): v is string => typeof v === "string";
const STAMP_MAX = 40;
/** Pi entry ids are short hex; anything else gets a positional id. */
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Commands are matched by regexes that backtrack on long input. */
const COMMAND_SCAN_MAX = 2_000;
/** Kept well under the bot's 2 MB response cap. */
const STEPS_BUDGET = 1_200_000;
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

interface ToolResultInfo {
  isError: boolean;
  text: string;
  at: string;
  details?: unknown;
}

/** One tool call as evidence sees it: the raw arguments, before any clipping. */
export interface ToolUse {
  name: string;
  args: Record<string, unknown>;
  ok: boolean | null;
  at: string;
}

export interface BuiltSteps {
  steps: RunStep[];
  uses: ToolUse[];
  verifyNudged: boolean;
}

const isStamp = (v: unknown): v is string => str(v) && v.length <= STAMP_MAX && !Number.isNaN(Date.parse(v));

/** The steps of a run's window, in file order. Ids are stable while the run appends: positional ones count from the window start. */
export function buildSteps(entries: Entry[]): BuiltSteps {
  const results = new Map<string, ToolResultInfo>();
  for (const e of entries) {
    const m = e.message;
    if (e.type === "message" && m?.role === "toolResult" && str(m.toolCallId) && isStamp(e.timestamp) && !results.has(m.toolCallId)) {
      results.set(m.toolCallId, { isError: m.isError === true, text: textOf(m.content), at: e.timestamp, details: m.details });
    }
  }
  const used = new Set<string>();
  const steps: RunStep[] = [];
  const uses: ToolUse[] = [];
  let verifyNudged = false;
  const push = (s: RunStep) => {
    if (runStep.safeParse(s).success) steps.push(s);
  };
  entries.forEach((e, i) => {
    if (!isStamp(e.timestamp)) return;
    const at = e.timestamp;
    const id = str(e.id) && ENTRY_ID.test(e.id) && !used.has(e.id) ? e.id : `#${i}`;
    used.add(id);
    const m = e.message;
    if (e.type === "message" && m?.role === "user") {
      push({ type: "user", id, at, text: safeText(textOf(m.content), RUN_STEP_LIMITS.user) });
    } else if (e.type === "message" && m?.role === "assistant") {
      const text = textOf(m.content).trim();
      if (text) push({ type: "assistant", id, at, text: safeText(text, RUN_STEP_LIMITS.assistant) });
      const calls = Array.isArray(m.content) ? (m.content as ToolCallItem[]).filter((c) => c?.type === "toolCall" && str(c.name)) : [];
      calls.forEach((c, k) => {
        const result = str(c.id) ? results.get(c.id) : undefined;
        const args = c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments) ? (c.arguments as Record<string, unknown>) : {};
        const ok = result ? !result.isError : null;
        uses.push({ name: c.name as string, args, ok, at });
        const duration = result ? Date.parse(result.at) - Date.parse(at) : Number.NaN;
        const child = (result?.details as { runId?: unknown } | undefined)?.runId;
        let argText = "";
        try {
          argText = JSON.stringify(c.arguments ?? {}) ?? "";
        } catch {}
        push({
          type: "tool",
          id: `${id}/t${k}`,
          at,
          name: safeText(c.name as string, ID_MAX, { oneLine: true }),
          args: safeText(argText, RUN_STEP_LIMITS.toolArgs, { oneLine: true }),
          ok,
          result: result ? safeText(result.text, RUN_STEP_LIMITS.toolResult) : "",
          ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: Math.round(duration) } : {}),
          ...(str(child) && RUN_ID_RE.test(child) ? { agentId: child } : {}),
        });
      });
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        const why = str(m.errorMessage) && m.errorMessage ? publicAuthError(m.errorMessage.slice(0, 4_000)) : m.stopReason;
        push({ type: "note", id: `${id}/stop`, at, kind: m.stopReason, text: safeText(why, RUN_STEP_LIMITS.note, { oneLine: true }) });
      }
    } else if (e.type === "compaction" && str(e.summary)) {
      push({ type: "note", id, at, kind: "compaction", text: safeText(e.summary, RUN_STEP_LIMITS.note) });
    } else if (e.type === "custom_message") {
      const verify = e.customType === VERIFY_CUSTOM_TYPE;
      if (verify) verifyNudged = true;
      const label = str(e.customType) && !verify ? `[${e.customType.slice(0, 64)}] ` : "";
      push({ type: "note", id, at, kind: verify ? "verify" : "custom", text: safeText(label + textOf(e.content), RUN_STEP_LIMITS.note) });
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

export function buildEvidence(uses: ToolUse[], verifyNudged: boolean, home: string): RunEvidence {
  const checks: RunEvidence["checks"] = [];
  const repos = new Set<string>();
  const filesSent: RunEvidence["filesSent"] = [];
  const memoryWrites: RunEvidence["memoryWrites"] = [];
  let changed = false;
  let unverified = false;
  const change = (repo: string) => {
    repos.add(safeText(repo, 100, { oneLine: true }));
    changed = true;
    unverified = true;
  };
  for (const u of uses) {
    const path = str(u.args.path) ? u.args.path.slice(0, 4_096) : null;
    if (u.name === "bash" && str(u.args.command)) {
      const cmd = u.args.command.slice(0, COMMAND_SCAN_MAX);
      const repo = bashChangedRepo(cmd);
      if (repo) change(repo);
      const mem = bashMutates(cmd) ? MEMORY_IN_BASH.exec(cmd)?.[1] : undefined;
      if (mem) memoryWrites.push({ path: mem, tool: "bash", at: u.at });
      // A failing check still counts, as in the verify gate: the agent saw the result.
      if (isCheckCommand(cmd)) {
        checks.push({ command: safeText(cmd, 200, { oneLine: true }), ok: u.ok, at: u.at });
        unverified = false;
      }
    } else if ((u.name === "edit" || u.name === "write") && path && u.ok !== false) {
      const rel = homeRelative(path, home);
      if (!rel) continue;
      const parts = rel.split("/");
      if (parts[0] === "projects" && parts[1]) change(parts[1]);
      if (isMemoryRel(rel)) memoryWrites.push({ path: safeText(rel, 300, { oneLine: true }), tool: u.name, at: u.at });
    } else if (u.name === SEND_FILE_TOOL && path && u.ok === true) {
      const name = str(u.args.name) && u.args.name.trim() ? u.args.name.trim() : basename(path);
      filesSent.push({ name: safeText(name, ID_MAX, { oneLine: true }), at: u.at });
    }
  }
  return {
    checks: checks.slice(-CHECKS_MAX),
    changedRepos: [...repos].slice(0, REPOS_MAX),
    checkAfterLastChange: changed ? !unverified : null,
    verifyNudged,
    filesSent: filesSent.slice(0, FILES_SENT_MAX),
    memoryWrites: memoryWrites.slice(0, MEMORY_WRITES_MAX),
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

function page(steps: RunStep[], after: string | undefined, limit: number): { steps: RunStep[]; after: string | null } {
  let start = 0;
  if (after !== undefined) {
    const at = steps.findIndex((s) => s.id === after);
    if (at === -1) throw new RpcHandlerError("unknown steps cursor", -32602);
    start = at + 1;
  }
  const out: RunStep[] = [];
  let bytes = 0;
  for (let i = start; i < steps.length && out.length < limit; i++) {
    const size = Buffer.byteLength(JSON.stringify(steps[i]));
    if (out.length && bytes + size > STEPS_BUDGET) break;
    bytes += size;
    out.push(steps[i]!);
  }
  return { steps: out, after: start + out.length < steps.length ? out.at(-1)!.id : null };
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
      built = buildSteps((await entriesInWindow(session, from, Number.isNaN(to) ? Number.POSITIVE_INFINITY : to)).entries);
    } finally {
      await session.fh.close();
    }
  }
  const { steps, after } = page(built.steps, params.after, params.limit);

  const startedAt = new Date(run.startedAt);
  const rel = Number.isNaN(startedAt.getTime()) ? null : runFileRel(run.runId, startedAt, opts.tz);
  const historyFile = root && rel && (await existingRunFile(root, rel)) ? rel : undefined;
  return runsGetResult.parse({
    found: true,
    run,
    ...(parent ? { parent } : {}),
    children: childrenOf(index, run.runId),
    session: session.state,
    steps,
    after,
    ...(params.after === undefined ? { evidence: buildEvidence(built.uses, built.verifyNudged, opts.home) } : {}),
    ...(historyFile ? { historyFile } : {}),
  });
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
