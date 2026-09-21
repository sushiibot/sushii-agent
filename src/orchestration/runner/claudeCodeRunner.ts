import simpleGit from "simple-git";
import { getLogger } from "../../logger.ts";
import type { HandbackMeta, RunnerAdapter, RunnerEvent } from "../contracts.ts";

const log = getLogger("orchestration.runner.claudeCode");

// Claude Code CLI stream-json shape (`claude --output-format stream-json --verbose`):
//   {"type":"system","subtype":"init","session_id":"..."}
//   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
//   {"type":"result","subtype":"success"|..., "is_error":bool, "result":"...",
//    "duration_ms":n, "total_cost_usd":n, "usage":{"input_tokens":n,"output_tokens":n},
//    "permission_denials":[...]}
// Unknown event types (hooks, rate_limit_event, informational) are ignored.
export type StreamLineEvent =
  | { type: "init"; sessionId: string }
  | { type: "tool_use"; name: string; detail?: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "assistant_text"; text: string }
  | {
      type: "result";
      success: boolean;
      resultText?: string;
      durationMs?: number;
      costUsd?: number;
      tokens?: number;
      denials?: number;
      errorMessage?: string;
    };

// Collapse whitespace to one line, then cap — for the terse single-line tool label.
function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Cap length but PRESERVE newlines/formatting. Truncation for a narrow surface (the Discord tail) is a
// display concern handled there; the wire carries the full text so the web viewer renders real
// markdown. The bound is only a memory guard against a pathological payload, well above normal output.
function cap(text: string, max: number): string {
  const t = text.replace(/\s+$/, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// One typed display entry per activity signal for the live views. null for signals with nothing to
// show. Text + results keep their formatting; each surface clips for its own width (web shows full,
// Discord collapses to a glance line). Results are hidden by default and revealed on demand on the web.
export function activityEntry(sig: StreamLineEvent): { line: string; atype: "tool" | "result" | "text" } | null {
  switch (sig.type) {
    case "tool_use":
      return { line: `${sig.name}${sig.detail ? ` ${truncate(sig.detail, 200)}` : ""}`, atype: "tool" };
    case "tool_result":
      return { line: `${sig.isError ? "✗ " : ""}${cap(sig.output, 4000)}`, atype: "result" };
    case "assistant_text":
      return { line: cap(sig.text, 8000), atype: "text" };
    default:
      return null;
  }
}

// The meaningful field of a tool's input for the activity line (the command/path/pattern), else a
// compact key=value — never a raw JSON dump. Shared shape with the Pi runner's summarizer.
function summarizeArgs(input: unknown): string | undefined {
  if (typeof input === "string") return input || undefined;
  if (input && typeof input === "object") {
    const a = input as Record<string, unknown>;
    for (const k of ["command", "path", "file_path", "pattern", "query", "url"]) {
      if (typeof a[k] === "string" && a[k]) return a[k] as string;
    }
    const parts = Object.entries(a)
      .filter(([, v]) => v != null && typeof v !== "object")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
    return parts.join(" ") || undefined;
  }
  return undefined;
}

// Claude Code tool_result content is a string or an array of text blocks.
function claudeResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content).slice(0, 1500);
  } catch {
    return String(content);
  }
}

export function parseClaudeStreamLine(json: unknown): StreamLineEvent[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;

  if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return [{ type: "init", sessionId: obj.session_id }];
  }

  if (obj.type === "assistant") {
    const message = obj.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const signals: StreamLineEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") {
        signals.push({ type: "tool_use", name: b.name, detail: summarizeArgs(b.input) });
      } else if (b.type === "text" && typeof b.text === "string") {
        signals.push({ type: "assistant_text", text: b.text });
      }
    }
    return signals;
  }

  // Tool results come back as `user` messages carrying tool_result blocks.
  if (obj.type === "user") {
    const message = obj.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const signals: StreamLineEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        signals.push({ type: "tool_result", name: "", output: claudeResultText(b.content), isError: b.is_error === true });
      }
    }
    return signals;
  }

  if (obj.type === "result") {
    const isError = obj.is_error === true || obj.subtype !== "success";
    const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const tokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined;
    const errors = Array.isArray(obj.errors) ? obj.errors.filter((e) => typeof e === "string") : undefined;
    const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials.length : undefined;
    return [
      {
        type: "result",
        success: !isError,
        resultText: typeof obj.result === "string" ? obj.result : undefined,
        durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : undefined,
        costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        tokens,
        denials,
        // Error result subtypes carry `errors: string[]`, not `result` — only
        // subtype:"success" has `result` on the SDKResultMessage union.
        errorMessage: isError
          ? errors && errors.length > 0
            ? errors.join("; ")
            : typeof obj.result === "string"
              ? obj.result
              : String(obj.subtype ?? "claude exited with an error")
          : undefined,
      },
    ];
  }

  return [];
}

// Reduces a sequence of StreamLineEvents into ordered RunnerEvents, debouncing
// tool/assistant activity into a single "progress" note per debounceMs window
// instead of one per line. The pending note is force-flushed right before the
// terminal handback, so nothing gets dropped at the end of a run.
export class RunnerEventReducer {
  private pendingActivity: string[] = [];
  private toolsRun = 0;
  private lastEmitAt: number;

  constructor(
    private readonly taskId: string,
    private readonly debounceMs: number,
    private readonly now: () => number,
  ) {
    // Anchors the debounce window to reducer creation (stream start) rather
    // than -Infinity, so the very first activity note is debounced too
    // instead of flushing alone before later activity in the same burst.
    this.lastEmitAt = now();
  }

  start(): RunnerEvent {
    return { kind: "status", taskId: this.taskId, status: "running" };
  }

  onSignal(sig: StreamLineEvent): RunnerEvent[] {
    const out: RunnerEvent[] = [];
    const activity = activityEntry(sig);
    if (activity) out.push({ kind: "activity", taskId: this.taskId, line: activity.line, atype: activity.atype, at: this.now() });
    switch (sig.type) {
      case "tool_use":
        this.toolsRun++;
        this.pendingActivity.push(`ran ${sig.name}`);
        this.flush(out, false);
        break;
      case "tool_result":
        break; // surfaced as an activity line above; not part of the debounced summary
      case "assistant_text":
        this.pendingActivity.push(truncate(sig.text));
        this.flush(out, false);
        break;
      case "result":
        this.flush(out, true);
        if (sig.success) {
          out.push({
            kind: "handback",
            taskId: this.taskId,
            summary: sig.resultText ?? "",
            meta: {
              toolsRun: this.toolsRun,
              tokens: sig.tokens,
              costUsd: sig.costUsd,
              durationMs: sig.durationMs,
              denials: sig.denials,
            },
          });
          // A successful turn rests at idle (session alive, awaiting the user's reply) per
          // ARCHITECTURE.md's status model — "done" is reserved for an explicit close.
          out.push({ kind: "status", taskId: this.taskId, status: "idle" });
        } else {
          out.push({
            kind: "status",
            taskId: this.taskId,
            status: "failed",
            reason: sig.errorMessage ?? "claude exited with an error",
          });
        }
        break;
      case "init":
        break;
    }
    return out;
  }

  // Flushes any pending activity note regardless of the debounce window.
  // Callers use this once they know no further signals are coming (end of a
  // fixture batch, or right before a terminal handback/failure).
  finalize(): RunnerEvent[] {
    const out: RunnerEvent[] = [];
    this.flush(out, true);
    return out;
  }

  private flush(out: RunnerEvent[], force: boolean): void {
    if (this.pendingActivity.length === 0) return;
    const t = this.now();
    if (!force && t - this.lastEmitAt < this.debounceMs) return;
    out.push({ kind: "progress", taskId: this.taskId, note: this.pendingActivity.join("; ") });
    this.pendingActivity = [];
    this.lastEmitAt = t;
  }
}

export interface BuildRunnerEventsOptions {
  debounceMs?: number;
  now?: () => number;
}

// Pure, hermetic entry point: turns a batch of raw stream-json lines into the
// full ordered RunnerEvent[] for a task. Used directly by the fixture test;
// the live adapter drives the same RunnerEventReducer incrementally instead.
export function buildRunnerEvents(
  taskId: string,
  rawLines: string[],
  opts: BuildRunnerEventsOptions = {},
): RunnerEvent[] {
  const reducer = new RunnerEventReducer(taskId, opts.debounceMs ?? 1500, opts.now ?? Date.now);
  const events: RunnerEvent[] = [reducer.start()];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const sig of parseClaudeStreamLine(parsed)) {
      events.push(...reducer.onSignal(sig));
    }
  }
  events.push(...reducer.finalize());
  return events;
}

// Single-consumer async line channel fed by a stdout reader loop.
class LineChannel {
  private buffer = "";
  private queue: string[] = [];
  private waiting: Array<(v: IteratorResult<string>) => void> = [];
  private closed = false;

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.emit(line);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.buffer) {
      this.emit(this.buffer);
      this.buffer = "";
    }
    while (this.waiting.length) {
      this.waiting.shift()!({ value: undefined, done: true });
    }
  }

  private emit(line: string): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.queue.push(line);
  }

  next(): Promise<IteratorResult<string>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift() as string, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

interface TaskState {
  proc: ReturnType<typeof Bun.spawn>;
  cwd: string;
  channel: LineChannel;
  startedAt: number;
  startSha: string | null;
  // Set by resume() right before it kills this proc, so the OLD stream()'s exit-detection branch
  // (below) knows the kill was an intentional supersede, not a crash, and stays silent instead of
  // emitting a false "failed".
  superseded: boolean;
}

export interface ClaudeCodeRunnerOptions {
  claudeBin?: string;
  progressDebounceMs?: number;
  now?: () => number;
  // Default is the unsandboxed-host posture: acceptEdits + allow Bash, prompts
  // denied (never blocks, no host to answer). NOT bypass/yolo — the CLI requires
  // a container/VM for --dangerously-skip-permissions, so a sandboxed runner
  // passes that explicitly instead. Kept an option, not a constant.
  permissionArgs?: string[];
}

export class ClaudeCodeRunnerAdapter implements RunnerAdapter {
  private readonly claudeBin: string;
  private readonly progressDebounceMs: number;
  private readonly now: () => number;
  private readonly permissionArgs: string[];
  private readonly tasks = new Map<string, TaskState>();

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.claudeBin = options.claudeBin ?? "claude";
    this.progressDebounceMs = options.progressDebounceMs ?? 1500;
    this.now = options.now ?? Date.now;
    this.permissionArgs = options.permissionArgs ?? [
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash",
      "--permission-prompts",
      "none",
    ];
  }

  async start(input: { taskId: string; cwd: string; prompt: string }): Promise<{ nativeSessionId: string }> {
    // `-p`/`--print` is a boolean flag; the prompt is a positional argument,
    // so its position in argv doesn't protect it — only `--` does, telling
    // commander to stop parsing options and take the rest positionally.
    const args = [
      this.claudeBin,
      "-p",
      "--output-format=stream-json",
      "--verbose",
      ...this.permissionArgs,
      "--",
      input.prompt,
    ];
    const proc = Bun.spawn({ cmd: args, cwd: input.cwd, stdout: "pipe", stderr: "pipe" });
    const channel = new LineChannel();
    void this.pumpStdout(proc, channel);
    void this.pumpStderr(proc);

    const startSha = await this.readHeadSha(input.cwd);
    const task: TaskState = { proc, cwd: input.cwd, channel, startedAt: this.now(), startSha, superseded: false };
    this.tasks.set(input.taskId, task);

    const sessionId = await this.readSessionId(channel);
    if (sessionId === null) {
      task.proc.kill();
      await task.proc.exited;
      this.tasks.delete(input.taskId);
      throw new Error(`claude exited before reporting a session id for task ${input.taskId}`);
    }
    return { nativeSessionId: sessionId };
  }

  async resume(input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string }): Promise<void> {
    const existing = this.tasks.get(input.taskId);
    if (existing) {
      // A still-running prior process for this task must not be silently
      // orphaned when the map entry is overwritten below. Mark it superseded
      // BEFORE killing it so its own stream() loop (see the exit-detection
      // branch below) treats the exit as an intentional supersede, not a crash.
      existing.superseded = true;
      existing.proc.kill();
      await existing.proc.exited;
    }
    // Registry-provided cwd wins (survives task settle + orchestrator restart); fall back to the
    // in-memory entry. Never silently use process.cwd() — that once committed into the wrong repo.
    // A legacy row with no recorded cwd fails loudly so the owner re-dispatches instead.
    const cwd = input.cwd || existing?.cwd;
    if (!cwd) {
      throw new Error(
        `no working directory recorded for task ${input.taskId} (created before cwd was tracked) — re-dispatch instead of resuming`,
      );
    }
    const args = [
      this.claudeBin,
      "--resume",
      input.nativeSessionId,
      "-p",
      "--output-format=stream-json",
      "--verbose",
      ...this.permissionArgs,
      "--",
      input.prompt,
    ];
    const proc = Bun.spawn({ cmd: args, cwd, stdout: "pipe", stderr: "pipe" });
    const channel = new LineChannel();
    void this.pumpStdout(proc, channel);
    void this.pumpStderr(proc);

    const startSha = existing?.startSha ?? (await this.readHeadSha(cwd));
    this.tasks.set(input.taskId, { proc, cwd, channel, startedAt: this.now(), startSha, superseded: false });
  }

  async interrupt(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.proc.kill();
    this.tasks.delete(taskId);
  }

  // Halt but stay resumable: `superseded` so the killed process emits no "failed", then kill. This
  // adapter runs in the caller's real project dir (not a throwaway worktree), so `discard` removes
  // nothing on disk — it only tells the dispatcher to record a terminal status.
  async stop(input: { taskId: string; discard?: boolean }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task) return;
    task.superseded = true;
    task.proc.kill();
    this.tasks.delete(input.taskId);
  }

  async stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);

    const reducer = new RunnerEventReducer(taskId, this.progressDebounceMs, this.now);
    onEvent(reducer.start());

    while (true) {
      const { value: line, done } = await task.channel.next();
      if (done) {
        // resume() kills this exact process on purpose and marks it superseded first — that kill's
        // exit must not surface as a task failure; the resumed process's own stream reports status.
        if (!task.superseded) {
          for (const event of reducer.finalize()) onEvent(event);
          onEvent({
            kind: "status",
            taskId,
            status: "failed",
            reason: `claude process exited (code ${task.proc.exitCode ?? "unknown"})`,
          });
        }
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      let terminal = false;
      for (const sig of parseClaudeStreamLine(parsed)) {
        for (const event of reducer.onSignal(sig)) {
          if (event.kind === "handback") {
            const gitMeta = await this.computeGitMeta(task.cwd, task.startSha);
            const meta: HandbackMeta = {
              ...event.meta,
              ...gitMeta,
              durationMs: event.meta?.durationMs ?? this.now() - task.startedAt,
            };
            onEvent({ ...event, meta });
          } else {
            onEvent(event);
          }
          // `-p`/`--print` mode always exits after one turn, success or failure, so idle (the
          // resting state for a successful turn) ends this process's stream same as done/failed.
          if (event.kind === "status" && (event.status === "idle" || event.status === "done" || event.status === "failed")) {
            terminal = true;
          }
        }
      }
      if (terminal) break;
    }

    // Keep the task in the map — so interrupt() can still reach the process —
    // until it has actually exited, then reap it. On the terminal-signal
    // break the child may still be finishing up after emitting its result
    // line, so bound the wait and kill it rather than blocking forever.
    await this.reap(task.proc);
    // resume() may have already replaced this taskId with a new process
    // while this loop was draining the old one's stream; only delete the
    // entry if it's still ours.
    if (this.tasks.get(taskId) === task) this.tasks.delete(taskId);
  }

  private async reap(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 5000): Promise<void> {
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private async pumpStdout(proc: ReturnType<typeof Bun.spawn>, channel: LineChannel): Promise<void> {
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) {
      channel.close();
      return;
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        channel.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      channel.close();
    }
  }

  // Drains stderr so the pipe buffer never fills and blocks the child
  // (Bun.spawn with stderr:"pipe" deadlocks if nothing reads it); logged for
  // diagnostics rather than surfaced as a RunnerEvent.
  private async pumpStderr(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stderr = proc.stderr;
    if (!(stderr instanceof ReadableStream)) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) log.warn({ stderr: text }, "claude stderr");
      }
    } catch (err) {
      log.error({ err }, "failed reading claude stderr");
    }
  }

  private async readSessionId(channel: LineChannel): Promise<string | null> {
    while (true) {
      const { value: line, done } = await channel.next();
      if (done) return null;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const sig of parseClaudeStreamLine(parsed)) {
        if (sig.type === "init") return sig.sessionId;
      }
    }
  }

  private async readHeadSha(cwd: string): Promise<string | null> {
    try {
      const sha = await simpleGit(cwd).revparse(["HEAD"]);
      return sha.trim();
    } catch (err) {
      log.error({ err, cwd }, "failed to read HEAD sha");
      return null;
    }
  }

  private async computeGitMeta(cwd: string, startSha: string | null): Promise<Partial<HandbackMeta>> {
    try {
      const git = simpleGit(cwd);
      const status = await git.status();
      const filesChanged = status.files.length;
      let commits = 0;
      if (startSha) {
        const gitLog = await git.log({ from: startSha, to: "HEAD" });
        commits = gitLog.total;
      }
      return { filesChanged, commits };
    } catch (err) {
      log.error({ err, cwd }, "failed to compute git handback metadata");
      return {};
    }
  }
}
