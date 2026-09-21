// Host-typed tools over the orchestration dispatcher (BRIEF: security-sensitive — every call
// routes through can() with the caller's principal + originating space before touching the
// dispatcher). No discord.js here; requiresHosts stays empty like ops-triage's owner-gated tools.
import type { ToolEntry, ToolContext } from "../../contracts.ts";
import type { Capability, RepoSpec } from "../../../orchestration/contracts.ts";
import { AuthzError, DispatcherUnavailableError, getDispatcher } from "../../../orchestration/dispatcher.ts";
import { can, spaceKey } from "../../../orchestration/authz.ts";

// One message for every denial reason (missing identity, wrong space, wrong principal) —
// distinguishing them would let a caller enumerate which check failed.
const DENIED = "This tool is unavailable in this space.";
const UNAVAILABLE = "Runner orchestration is unavailable right now.";

function principalOf(ctx: ToolContext): string | undefined {
  return ctx.owner?.userId;
}

// Accepts "owner/name" or a GitHub URL. Returns null on anything that isn't a clean single-segment
// repo path — so a stray extra path segment or a non-github URL is rejected, not clamped.
export function parseRepoSpec(input: string): RepoSpec | null {
  const trimmed = input.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!valid.test(parts[0]) || !valid.test(parts[1])) return null;
  return { owner: parts[0], repo: parts[1] };
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
    description: "Start a new background coding-agent task on a connected runner. Owner-only, personal spaces only. Two modes: (1) an existing on-disk project — call list_runners first to resolve the name to the runner + absolute path, and pass that as cwd; (2) clone-on-demand — pass `repo` as 'owner/name' (or a GitHub URL) and the runner clones it into its workspace, works, and opens a PR at handback; omit cwd in this mode. Don't guess a path.",
    parameters: {
      type: "object",
      properties: {
        runner_id: { type: "string", description: "Which connected runner to dispatch to (from list_runners)." },
        cwd: { type: "string", description: "Absolute working directory — a project path from list_runners, or a path nested under one. Omit when `repo` is given." },
        prompt: { type: "string", description: "The task prompt to hand the runner." },
        project: { type: "string", description: "Logical project name, for grouping/lookup." },
        repo: { type: "string", description: "Clone-on-demand: 'owner/name' or a GitHub URL. The runner clones it and opens a PR at handback. When set, cwd is derived and ignored." },
      },
      required: ["runner_id", "prompt"],
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
      // isRunnerLive() below can only ever be true once the transport is bound — bind it here
      // rather than waiting for dispatch() to, or a fresh process's first dispatch_to_runner call
      // would see "not connected" forever without ever reaching dispatch()'s own bind.
      dispatcher.ensureListening();
    } catch (err) {
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
      throw err;
    }
    if (!dispatcher.isRunnerLive(runnerId)) return { content: `Runner "${runnerId}" is not connected.` };

    let repo;
    if (input.repo) {
      repo = parseRepoSpec(input.repo as string);
      if (!repo) return { content: `Invalid repo "${input.repo}" — use 'owner/name' or a GitHub URL.` };
    }
    if (!repo && !input.cwd) return { content: "Provide either cwd (existing project) or repo (clone-on-demand)." };

    try {
      const task = await dispatcher.dispatch({
        principal,
        runnerId,
        cwd: (input.cwd as string | undefined) ?? "",
        project: (input.project as string | undefined) ?? null,
        prompt: input.prompt as string,
        space: spaceOf(ctx),
        spawnedFromSurface: ctx.space.surface,
        repo,
      });
      return { content: `Dispatched task ${task.id} on runner "${runnerId}" (native session ${task.nativeSessionId}).` };
    } catch (err) {
      if (err instanceof AuthzError) return { content: DENIED };
      // dispatch() binds the ORCH port lazily on first use, so a listen() failure surfaces here
      // rather than from the earlier getDispatcher() call.
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
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
    const snippet = (s: string | null) => (s && s.length > 100 ? `${s.slice(0, 99)}…` : (s ?? ""));
    return {
      content: tasks
        .map((t) => `${t.id} [${t.status}] runner=${t.runnerId} project=${t.project ?? "-"} updated=${new Date(t.updatedAt * 1000).toISOString()}${t.summary ? ` — ${snippet(t.summary)}` : ""}`)
        .join("\n"),
    };
  },
};

export const listRunnersEntry: ToolEntry = {
  name: "list_runners",
  definition: {
    name: "list_runners",
    description: "List connected runners and the projects (git repos) each can work on. Use this to answer 'what can you work on' and to resolve a project name (e.g. 'sushii-sns') to its runner + path before dispatch_to_runner. Owner-only, personal spaces only.",
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

    const runners = dispatcher.listRunners();
    if (runners.length === 0) return { content: "(no runners connected)" };
    return {
      content: runners
        .map((r) => {
          const projects = r.projects.length
            ? r.projects.map((p) => `  ${p.split("/").pop()} → ${p}`).join("\n")
            : "  (no projects declared — any cwd allowed)";
          return `${r.runnerId} [${r.kind}]\n${projects}`;
        })
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

export const resumeSessionEntry: ToolEntry = {
  name: "resume_session",
  definition: {
    name: "resume_session",
    description: "Resume one of your background runner tasks with a follow-up prompt. Owner-only, personal spaces only. If the user refers to a task by description, project, or recency ('the smoke-test one', 'the last task', 'continue') instead of an id, call list_running_sessions first and pick the matching task id — don't ask the user for the raw id.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task id (from dispatch_to_runner or list_running_sessions). Resolve it via list_running_sessions when the user gives a description rather than the id." },
        prompt: { type: "string", description: "Follow-up instructions for the runner." },
      },
      required: ["task_id", "prompt"],
    },
  },
  requiresHosts: [],
  async execute(input, ctx) {
    const taskId = input.task_id as string;
    const principal = authorize(ctx, "session.resume", taskId);
    if (!principal) return { content: DENIED };

    let dispatcher;
    try {
      dispatcher = getDispatcher();
      // The task being resumed can be durable state from a prior process (nativeSessionId +
      // ownership both persist in the registry), so — same as dispatch_to_runner — the transport
      // may never have been bound in THIS process yet; resume()'s own isRunnerLive() check can
      // only ever be true once it is.
      dispatcher.ensureListening();
    } catch (err) {
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
      throw err;
    }

    try {
      const task = await dispatcher.resume({ principal, taskId, prompt: input.prompt as string, space: spaceOf(ctx) });
      return { content: `Resumed task ${task.id} (status: ${task.status}).` };
    } catch (err) {
      if (err instanceof AuthzError) return { content: DENIED };
      if (err instanceof DispatcherUnavailableError) return { content: UNAVAILABLE };
      return { content: `Failed to resume: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const RUNNER_TOOL_ENTRIES: ToolEntry[] = [dispatchToRunnerEntry, listRunnersEntry, listRunningSessionsEntry, readSessionEntry, resumeSessionEntry];
