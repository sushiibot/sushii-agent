// Host-typed tools over the orchestration dispatcher (BRIEF: security-sensitive — every call
// routes through can() with the caller's principal + originating space before touching the
// dispatcher). No discord.js here; requiresHosts stays empty like ops-triage's owner-gated tools.
import type { ToolEntry, ToolContext } from "../../contracts.ts";
import type { Capability } from "../../../orchestration/contracts.ts";
import { AuthzError, DispatcherUnavailableError, getDispatcher } from "../../../orchestration/dispatcher.ts";
import { can, spaceKey } from "../../../orchestration/authz.ts";

// One message for every denial reason (missing identity, wrong space, wrong principal) —
// distinguishing them would let a caller enumerate which check failed.
const DENIED = "This tool is unavailable in this space.";
const UNAVAILABLE = "Runner orchestration is unavailable right now.";

function principalOf(ctx: ToolContext): string | undefined {
  return ctx.owner?.userId;
}

function spaceOf(ctx: ToolContext): string {
  return spaceKey(ctx.space.surface, ctx.space.spaceId);
}

/** Returns the caller's principal if `capability` is authorized for this turn, else undefined. */
function authorize(ctx: ToolContext, capability: Capability, resource?: string): string | undefined {
  const principal = principalOf(ctx);
  if (!principal) return undefined;
  return can({ principal, capability, resource, space: spaceOf(ctx) }) ? principal : undefined;
}

export const dispatchToRunnerEntry: ToolEntry = {
  name: "dispatch_to_runner",
  definition: {
    name: "dispatch_to_runner",
    description: "Start a new background coding-agent task on a connected runner. Owner-only, personal spaces only.",
    parameters: {
      type: "object",
      properties: {
        runner_id: { type: "string", description: "Which connected runner to dispatch to." },
        cwd: { type: "string", description: "Absolute working directory for the task." },
        prompt: { type: "string", description: "The task prompt to hand the runner." },
        project: { type: "string", description: "Logical project name, for grouping/lookup." },
      },
      required: ["runner_id", "cwd", "prompt"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const runnerId = input.runner_id as string;
    const principal = authorize(ctx, "runner.dispatch", runnerId);
    if (!principal) return { content: DENIED };

    let dispatcher;
    try {
      dispatcher = getDispatcher();
    } catch (err) {
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
      throw err;
    }
    if (!dispatcher.isRunnerLive(runnerId)) return { content: `Runner "${runnerId}" is not connected.` };

    try {
      const task = await dispatcher.dispatch({
        principal,
        runnerId,
        cwd: input.cwd as string,
        project: (input.project as string | undefined) ?? null,
        prompt: input.prompt as string,
        space: spaceOf(ctx),
        spawnedFromSurface: ctx.space.surface,
      });
      return { content: `Dispatched task ${task.id} on runner "${runnerId}" (native session ${task.nativeSessionId}).` };
    } catch (err) {
      if (err instanceof AuthzError) return { content: DENIED };
      return { content: `Failed to dispatch: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const listRunningSessionsEntry: ToolEntry = {
  name: "list_running_sessions",
  definition: {
    name: "list_running_sessions",
    description: "List your currently running or idle background runner tasks. Owner-only, personal spaces only.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  requiresHosts: [],
  async execute(_input, ctx) {
    const principal = authorize(ctx, "session.read");
    if (!principal) return { content: DENIED };

    let dispatcher;
    try {
      dispatcher = getDispatcher();
    } catch (err) {
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
      throw err;
    }

    const tasks = dispatcher.listRunning(principal);
    if (tasks.length === 0) return { content: "(no running sessions)" };
    return {
      content: tasks
        .map((t) => `${t.id} [${t.status}] runner=${t.runnerId} project=${t.project ?? "-"} updated=${new Date(t.updatedAt * 1000).toISOString()}`)
        .join("\n"),
    };
  },
};

export const readSessionEntry: ToolEntry = {
  name: "read_session",
  definition: {
    name: "read_session",
    description: "Read one of your background runner tasks by id — status and last handback summary. Owner-only, personal spaces only.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "The task id returned by dispatch_to_runner." } },
      required: ["task_id"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const taskId = input.task_id as string;
    const principal = authorize(ctx, "session.read", taskId);
    if (!principal) return { content: DENIED };

    let dispatcher;
    try {
      dispatcher = getDispatcher();
    } catch (err) {
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
      throw err;
    }

    const task = dispatcher.readTask(taskId, principal);
    // Ownership is already enforced by readTask's `principal` filter — this repeats it
    // defense-in-depth in case that filter is ever dropped from a call site.
    if (!task || task.createdBy !== principal) return { content: `No such task: ${taskId}` };
    return {
      content: `${task.id} [${task.status}]${task.statusReason ? ` (${task.statusReason})` : ""} runner=${task.runnerId} project=${task.project ?? "-"}\n${task.summary ?? "(no summary yet)"}`,
    };
  },
};

export const RUNNER_TOOL_ENTRIES: ToolEntry[] = [dispatchToRunnerEntry, listRunningSessionsEntry, readSessionEntry];
