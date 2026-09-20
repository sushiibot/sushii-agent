// Wires the WS transport (server.ts) + durable registry (registry.ts) + a live-runners map into
// one seam the host-typed runner tools call through. Every dispatch is authz-gated FIRST.
import { getLogger } from "../logger.ts";
import type { CanFn, RunnerEvent, TaskRow } from "./contracts.ts";
import { TaskRegistry } from "./registry.ts";
import { OrchestrationServer } from "./transport/server.ts";
import { getDb } from "../db/index.ts";
import { can } from "./authz.ts";

const logger = getLogger("orchestration:dispatcher");

export class AuthzError extends Error {}

interface LiveRunner {
  kind: string;
  projects: string[];
}

export interface DispatchInput {
  principal: string;
  runnerId: string;
  cwd: string;
  project: string | null;
  prompt: string;
  space: string;
  spawnedFromSurface: string;
  threadRefs?: string[];
}

export interface ResumeInput {
  principal: string;
  taskId: string;
  prompt: string;
  space: string;
}

export interface DispatcherOptions {
  port?: number;
}

export class Dispatcher {
  readonly server: OrchestrationServer;
  private readonly liveRunners = new Map<string, LiveRunner>();
  private readonly settledListeners: ((task: TaskRow) => void)[] = [];
  private readonly runnerStatusListeners: ((e: { runnerId: string; status: "connected" | "disconnected" }) => void)[] = [];
  private listening = false;
  private listenFailed = false;

  constructor(
    private readonly registry: TaskRegistry,
    private readonly canFn: CanFn,
    options: DispatcherOptions = {},
  ) {
    this.server = new OrchestrationServer({
      port: options.port,
      onRegister: (runnerId, kind, projects) => {
        this.liveRunners.set(runnerId, { kind, projects });
        // A fresh connection means we can't observe any turn that was mid-flight on this runner
        // before (e.g. across an orchestrator restart), so clear stale "running" phantoms.
        const reconciled = this.registry.failRunningForRunner(
          runnerId,
          "runner reconnected; prior turn's result was not observed (no resume-catchup yet)",
        );
        if (reconciled > 0) logger.info({ runnerId, reconciled }, "reconciled stale running tasks on runner register");
        this.emitRunnerStatus(runnerId, "connected");
      },
      onDisconnect: (runnerId) => {
        this.liveRunners.delete(runnerId);
        this.emitRunnerStatus(runnerId, "disconnected");
      },
      onEvent: (runnerId, event) => this.onEvent(runnerId, event),
    });
  }

  listen(): void {
    this.server.listen();
    this.listening = true;
  }

  /** Idempotent bind. Called at boot (gateway.ts) so a runner reconnects immediately after a
   *  restart, and again from the runner tools as a safety net — a runner tool must bind before its
   *  isRunnerLive() check, which can only be true after the port is bound. A prior listen() failure
   *  is remembered rather than retried on every call — the conflict won't resolve itself mid-process. */
  ensureListening(): void {
    if (this.listening) return;
    if (this.listenFailed) throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
    try {
      this.listen();
    } catch (err) {
      this.listenFailed = true;
      logger.error({ err }, "orchestration dispatcher failed to start; runner tools disabled for this process");
      throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
    }
  }

  stop(): void {
    this.server.stop();
  }

  isRunnerLive(runnerId: string): boolean {
    return this.liveRunners.has(runnerId) && this.server.isConnected(runnerId);
  }

  /** Authz-gates first (throws AuthzError if denied), then creates the task row and starts it.
   *  Returns once the task is created + started — events stream in asynchronously via onEvent. */
  async dispatch(input: DispatchInput): Promise<TaskRow> {
    const allowed = this.canFn({
      principal: input.principal,
      capability: "runner.dispatch",
      resource: input.runnerId,
      space: input.space,
    });
    if (!allowed) throw new AuthzError("runner.dispatch denied");

    this.ensureListening();

    const row = this.registry.create({
      createdBy: input.principal,
      runnerId: input.runnerId,
      project: input.project,
      cwd: input.cwd,
      nativeSessionId: null,
      resumeCursor: null,
      status: "running",
      statusReason: null,
      summary: null,
      spawnedFromSurface: input.spawnedFromSurface,
      threadRefs: input.threadRefs ?? [],
    });

    try {
      const result = (await this.server.start(input.runnerId, {
        taskId: row.id,
        cwd: input.cwd,
        prompt: input.prompt,
      })) as { nativeSessionId: string };
      this.registry.setNativeSession(row.id, result.nativeSessionId);
      return { ...row, nativeSessionId: result.nativeSessionId };
    } catch (err) {
      logger.error({ err, taskId: row.id }, "failed to start runner task");
      // An onEvent may have already raced this and applied a terminal status (e.g. an immediate
      // "failed" from the runner) — don't clobber it back to "failed" with a possibly different
      // reason, and don't resurrect a "done" task as "failed".
      const current = this.registry.get(row.id);
      if (current && current.status !== "done" && current.status !== "failed") {
        this.registry.updateStatus(row.id, "failed", err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }

  /** Same authz-first shape as dispatch(); ownership (task.createdBy) is checked in addition to the
   *  capability grant, defense-in-depth symmetric with readTask's principal filter. The
   *  no-overlapping-session invariant (never two live processes for one task) is NOT enforced
   *  here — it relies on the runner adapter layer (e.g. ClaudeCodeRunnerAdapter.resume()) killing
   *  the prior process before starting the new one. */
  async resume(input: ResumeInput): Promise<TaskRow> {
    const allowed = this.canFn({
      principal: input.principal,
      capability: "session.resume",
      resource: input.taskId,
      space: input.space,
    });
    if (!allowed) throw new AuthzError("session.resume denied");

    const task = this.registry.get(input.taskId);
    if (!task || task.createdBy !== input.principal) throw new AuthzError("session.resume denied");
    if (!task.nativeSessionId) throw new Error(`task ${input.taskId} has no native session to resume`);
    if (!this.isRunnerLive(task.runnerId)) throw new Error(`runner "${task.runnerId}" is not connected`);

    try {
      await this.server.resume(task.runnerId, {
        taskId: task.id,
        nativeSessionId: task.nativeSessionId,
        cwd: task.cwd ?? "", // empty → runner falls back (legacy rows predate the cwd column)
        prompt: input.prompt,
      });
    } catch (err) {
      logger.error({ err, taskId: task.id }, "failed to resume runner task");
      const current = this.registry.get(task.id);
      if (current && current.status !== "done" && current.status !== "failed") {
        this.registry.updateStatus(task.id, "failed", err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    return this.registry.get(task.id) as TaskRow;
  }

  /** Registers a callback invoked once per task turn SETTLING — {idle, done, failed} (per
   *  ARCHITECTURE.md's status model, a successful turn rests at idle, not done; done is reserved
   *  for explicit close). The Discord surface uses this to post a status line WITHOUT the
   *  dispatcher importing discord.js — the callback is the only seam. Listener errors are caught
   *  so one throwing surface can't break another or wedge event handling. */
  onTaskSettled(listener: (task: TaskRow) => void): void {
    this.settledListeners.push(listener);
  }

  /** Runner connect/disconnect notifications (same discord.js-free seam as onTaskSettled). */
  onRunnerStatus(listener: (e: { runnerId: string; status: "connected" | "disconnected" }) => void): void {
    this.runnerStatusListeners.push(listener);
  }

  private emitRunnerStatus(runnerId: string, status: "connected" | "disconnected"): void {
    for (const listener of this.runnerStatusListeners) {
      try {
        listener({ runnerId, status });
      } catch (err) {
        logger.error({ err, runnerId, status }, "runner-status listener threw");
      }
    }
  }

  private onEvent(reportingRunnerId: string, event: RunnerEvent): void {
    try {
      this.applyEvent(reportingRunnerId, event);
    } catch (err) {
      logger.error({ err, event }, "failed to apply runner event to registry");
    }
  }

  /** Every event is scoped to the runner that dispatch() recorded as owning the task — a runner
   *  reporting on a taskId it didn't start is dropped, not applied (P0 write-side integrity: full
   *  WS registration auth is Phase 1). Status dedupe reads the registry's own current status
   *  instead of separate in-process state, so there's nothing to leak across the task's lifetime. */
  private applyEvent(reportingRunnerId: string, event: RunnerEvent): void {
    const task = this.registry.get(event.taskId);
    if (!task || task.runnerId !== reportingRunnerId) {
      logger.warn(
        { taskId: event.taskId, reportingRunnerId, ownerRunnerId: task?.runnerId },
        "dropping runner event: reporting runner does not own this task",
      );
      return;
    }

    switch (event.kind) {
      case "status": {
        if (task.status === event.status) return;
        this.registry.updateStatus(event.taskId, event.status, event.reason);
        if (event.status === "idle" || event.status === "done" || event.status === "failed") {
          const updated = this.registry.get(event.taskId);
          if (updated) {
            for (const listener of this.settledListeners) {
              try {
                listener(updated);
              } catch (err) {
                logger.error({ err, taskId: event.taskId }, "onTaskSettled listener threw");
              }
            }
          }
        }
        return;
      }
      case "progress":
        logger.debug({ taskId: event.taskId, note: event.note }, "runner progress");
        return;
      case "handback":
        this.registry.setSummary(event.taskId, event.summary);
        return;
    }
  }

  listRunning(principal: string): TaskRow[] {
    return this.registry.listByPrincipal(principal).filter((t) => t.status === "running" || t.status === "idle");
  }

  /** `principal`, when given, scopes the lookup to tasks that principal created (defense-in-depth,
   *  symmetric with dispatch()'s authz gate) — the tool layer keeps its own ownership check too. */
  readTask(id: string, principal?: string): TaskRow | undefined {
    const row = this.registry.get(id);
    if (!row) return undefined;
    if (principal !== undefined && row.createdBy !== principal) return undefined;
    return row;
  }
}

export class DispatcherUnavailableError extends Error {}

let singleton: Dispatcher | null = null;
let startupFailed = false;

/** Process-wide dispatcher, lazily constructed on first use against the real DB/authz. Construction
 *  does NOT bind the ORCH port — that happens lazily inside dispatch() (see Dispatcher.ensureListening)
 *  on the first real dispatch, so wiring onTaskSettled at boot (gateway.ts) never binds a port an
 *  unused orchestration feature has no business claiming.
 *  NOTE: ORCH_PORT defaults to 8788, distinct from `mcpBridgePort`'s 8787 default (config.ts) —
 *  `runner/index.ts`'s ORCH_URL default dials the same 8788, so the two features never collide
 *  on a deploy that runs both without either port set explicitly. */
export function getDispatcher(): Dispatcher {
  if (startupFailed) throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
  if (!singleton) {
    try {
      const port = Number(process.env["ORCH_PORT"] ?? "8788");
      singleton = new Dispatcher(new TaskRegistry(getDb()), can, { port });
    } catch (err) {
      startupFailed = true;
      logger.error({ err }, "orchestration dispatcher failed to start; runner tools disabled for this process");
      throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
    }
  }
  return singleton;
}
