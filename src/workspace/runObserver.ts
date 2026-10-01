import { SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../logger.ts";
import { mapSessionEvent, newRunAccumulator, type RunAccumulator } from "./events.ts";
import type { EndRunInput, RunRecorder } from "./runLog.ts";

const log = getLogger("workspace.runs");
const tracer = trace.getTracer("sushii-workspace");

export interface ObservableSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

export interface ObserveRunsOptions {
  recorder: RunRecorder;
  sessionFile: string;
  /** "main" for the chat session. */
  agentName: string;
  parentRunId?: string;
  /** Model label when the run produced no assistant message. */
  defaultModel?: string;
  /** The Main turn this run answers, read when the run starts. */
  turnId?: () => string | undefined;
}

interface OpenRun {
  startedAt: Date;
  runId: string | null;
  acc: RunAccumulator;
  span: Span;
  tools: Map<string, Span>;
}

export interface RunObserver {
  unsubscribe(): void;
  /** The runId of the run in progress, e.g. a subagent's parentRunId; null between runs. */
  currentRunId(): string | null;
  /** The runId of the latest run started, still set after it ends; null before the first. */
  lastRunId(): string | null;
}

/**
 * Records every run of `session` (agent_start → agent_settled, steers included) in the run index,
 * with a `workspace.turn` span per run and a `workspace.tool` span per tool call.
 */
export function observeRuns(session: ObservableSession, opts: ObserveRunsOptions): RunObserver {
  let run: OpenRun | null = null;
  let lastRunId: string | null = null;

  const begin = (r: OpenRun, task: string): string => {
    if (r.runId) return r.runId;
    const turnId = opts.turnId?.();
    const runId = opts.recorder.startRun({
      agentName: opts.agentName,
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(turnId ? { turnId } : {}),
      task,
      sessionFile: opts.sessionFile,
      startedAt: r.startedAt,
    });
    r.runId = runId;
    lastRunId = runId;
    r.span.setAttribute("runId", runId);
    log.info({ runId, agentName: opts.agentName }, "run started");
    return runId;
  };

  const finish = (forced?: EndRunInput["status"]) => {
    const r = run;
    run = null;
    if (!r) return;
    const status = forced ?? runStatus(r.acc);
    const resultSummary = r.acc.errorMessage ?? (r.acc.finalText.trim() || undefined);
    let runId: string | null = null;
    try {
      runId = begin(r, "");
      opts.recorder.endRun(runId, {
        status,
        usage: { inputTokens: r.acc.inputTokens, outputTokens: r.acc.outputTokens, costUsd: r.acc.costUsd, ...(r.acc.model ? { model: r.acc.model } : {}) },
        ...(resultSummary ? { resultSummary } : {}),
      });
    } catch (err) {
      log.error({ err, runId }, "failed to record the end of a run");
    }
    for (const span of r.tools.values()) span.end();
    r.span.setAttributes({ model: r.acc.model ?? opts.defaultModel ?? "unknown", status });
    if (status === "failed") r.span.setStatus({ code: SpanStatusCode.ERROR, message: r.acc.errorMessage });
    r.span.end();
    log.info(
      { runId, agentName: opts.agentName, status, model: r.acc.model, inputTokens: r.acc.inputTokens, outputTokens: r.acc.outputTokens },
      "run settled",
    );
  };

  const onEvent = (event: AgentSessionEvent) => {
    if (event.type === "agent_start") {
      if (run) return;
      const span = tracer.startSpan("workspace.turn", { attributes: { agentName: opts.agentName } });
      run = { startedAt: new Date(), runId: null, acc: newRunAccumulator(), span, tools: new Map() };
      return;
    }
    if (!run) return;
    if (event.type === "agent_settled") {
      finish();
      return;
    }
    if (event.type === "message_start" && event.message.role === "user") {
      begin(run, messageText(event.message));
      return;
    }
    // Lifecycle events and Pi's system message precede the user message; only model output starts a run without one.
    if (!isOutput(event)) return;
    const runId = begin(run, "");
    if (event.type === "tool_execution_start") {
      const parent = trace.setSpan(context.active(), run.span);
      const span = tracer.startSpan("workspace.tool", { attributes: { runId, tool: event.toolName } }, parent);
      run.tools.set(event.toolCallId, span);
      log.debug({ runId, tool: event.toolName }, "tool started");
    } else if (event.type === "tool_execution_end") {
      const ok = event.isError !== true;
      const span = run.tools.get(event.toolCallId);
      run.tools.delete(event.toolCallId);
      if (span) {
        span.setAttribute("ok", ok);
        if (!ok) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
      log.debug({ runId, tool: event.toolName, ok }, "tool finished");
    }
    mapSessionEvent(event, run.acc);
  };

  const unsubscribe = session.subscribe((event) => {
    try {
      onEvent(event);
    } catch (err) {
      log.error({ err }, "run observer failed on a session event");
    }
  });

  // A session disposed mid-run (chat/new, shutdown) never settles; close its run here.
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    try {
      unsubscribe();
      if (run) finish("aborted");
    } catch (err) {
      log.error({ err }, "run observer failed to close the run on dispose");
    } finally {
      dispose();
    }
  };
  return { unsubscribe, currentRunId: () => run?.runId ?? null, lastRunId: () => lastRunId };
}

function isOutput(event: AgentSessionEvent): boolean {
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") return true;
  if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return false;
  return (event.message as { role?: string } | undefined)?.role === "assistant";
}

// A run only finishes normally on stop/length; one that settles mid tool use or with no reply was stopped.
export function runStatus(acc: RunAccumulator): EndRunInput["status"] {
  if (acc.lastStopReason === "stop" || acc.lastStopReason === "length") return "done";
  if (acc.lastStopReason === "error") return "failed";
  return "aborted";
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}
