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

export interface DispatcherOptions {
  port?: number;
}

export class Dispatcher {
  readonly server: OrchestrationServer;
  private readonly liveRunners = new Map<string, LiveRunner>();

  constructor(
    private readonly registry: TaskRegistry,
    private readonly canFn: CanFn,
    options: DispatcherOptions = {},
  ) {
    this.server = new OrchestrationServer({
      port: options.port,
      onRegister: (runnerId, kind, projects) => {
        this.liveRunners.set(runnerId, { kind, projects });
      },
      onEvent: (runnerId, event) => this.onEvent(runnerId, event),
    });
  }

  listen(): void {
    this.server.listen();
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

    const row = this.registry.create({
      createdBy: input.principal,
      runnerId: input.runnerId,
      project: input.project,
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

/** Process-wide dispatcher, lazily constructed on first tool use against the real DB/authz.
 *  NOTE: ORCH_PORT defaults to 8787, the same default `mcpBridgePort` uses (config.ts) and the
 *  same port `runner/index.ts`'s ORCH_URL default dials — a deploy running both needs ORCH_PORT
 *  (and/or MCP_BRIDGE_PORT) set explicitly to avoid an EADDRINUSE on whichever binds second.
 *  A listen() failure (e.g. that port clash) is remembered rather than retried on every call —
 *  the conflict won't resolve itself mid-process, so retrying would just re-throw forever and
 *  wedge every runner tool call behind a raw error instead of a clean "unavailable" response. */
export function getDispatcher(): Dispatcher {
  if (startupFailed) throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
  if (!singleton) {
    try {
      const port = Number(process.env["ORCH_PORT"] ?? "8787");
      const dispatcher = new Dispatcher(new TaskRegistry(getDb()), can, { port });
      dispatcher.listen();
      singleton = dispatcher;
    } catch (err) {
      startupFailed = true;
      logger.error({ err }, "orchestration dispatcher failed to start; runner tools disabled for this process");
      throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
    }
  }
  return singleton;
}
