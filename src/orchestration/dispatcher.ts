import { randomBytes } from "node:crypto";
// Wires the WS transport (server.ts) + durable registry (registry.ts) + a live-runners map into
// one seam the host-typed runner tools call through. Every dispatch is authz-gated FIRST.
import { getLogger } from "../logger.ts";
import type { CanFn, RepoSpec, RunnerEvent, TaskRow } from "./contracts.ts";
import { TaskRegistry } from "./registry.ts";
import { getActivityHub } from "./activityHub.ts";
import { OrchestrationServer } from "./transport/server.ts";
import { getDb } from "../db/index.ts";
import { can } from "./authz.ts";
import { TaskMessageStore, type TaskMessage } from "./taskMessages.ts";

const logger = getLogger("orchestration:dispatcher");

export class AuthzError extends Error {}

const safePath = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

interface LiveRunner {
  kind: string;
  projects: string[];
  workspaceRoot: string | null;
  location: string | null;
  capabilities: string[];
}

export interface DispatchInput {
  principal: string;
  runnerId: string;
  cwd: string;
  project: string | null;
  prompt: string;
  space: string;
  /** Private/DM context signal, forwarded to canFn's personal-space check. */
  isPrivate?: boolean;
  spawnedFromSurface: string;
  threadRefs?: string[];
  // Clone-on-demand: when set, the orchestrator derives the cwd under the runner's workspace root
  // (per-principal) and the runner clones owner/repo there. `cwd` is then ignored.
  repo?: RepoSpec | null;
}

export interface ResumeInput {
  principal: string;
  taskId: string;
  prompt: string;
  space: string;
  isPrivate?: boolean;
}

export interface HaltInput {
  principal: string;
  taskId: string;
  space: string;
  isPrivate?: boolean;
  discard?: boolean; // true = also reclaim the worktree, terminal (not resumable)
}

export interface SteerInput {
  principal: string;
  taskId: string;
  space: string;
  isPrivate?: boolean;
  text: string;
}

export interface DispatcherOptions {
  port?: number;
}

export class Dispatcher {
  readonly server: OrchestrationServer;
  private readonly liveRunners = new Map<string, LiveRunner>();
  private readonly settledListeners: ((task: TaskRow) => void)[] = [];
  private readonly startedListeners: ((task: TaskRow) => void)[] = [];
  private readonly runnerStatusListeners: ((e: { runnerId: string; status: "connected" | "disconnected" }) => void)[] = [];
  private readonly taskMessageListeners: ((message: TaskMessage) => void)[] = [];
  private listening = false;
  private listenFailed = false;

  constructor(
    private readonly registry: TaskRegistry,
    private readonly canFn: CanFn,
    options: DispatcherOptions = {},
    private readonly taskMessages?: TaskMessageStore,
  ) {
    this.server = new OrchestrationServer({
      port: options.port,
      onRegister: (runnerId, kind, projects, workspaceRoot, location, capabilities) => {
        this.liveRunners.set(runnerId, { kind, projects, workspaceRoot, location, capabilities });
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
    getActivityHub().setBrowserWatchHandler((taskId, watch) => this.watchBrowser(taskId, watch));
  }

  // Relay the task's live browser only while a web viewer has the browser panel open.
  private watchBrowser(taskId: string, watch: boolean): void {
    const task = this.registry.get(taskId);
    if (!task || !this.isRunnerLive(task.runnerId)) return;
    this.server
      .watchBrowser(task.runnerId, { taskId, watch })
      .then((res) => {
        if ((res as { supported?: boolean }).supported === false) getActivityHub().pushBrowser(taskId, { supported: false });
      })
      .catch((err) => logger.warn({ err, taskId, watch }, "browser watch request failed"));
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

  /** Live runners + the git repos each declared, for a "what can you work on" listing and for the
   *  agent to resolve a project name → cwd. */
  listRunners(): { runnerId: string; kind: string; projects: string[]; workspaceRoot: string | null; capabilities: string[] }[] {
    return [...this.liveRunners.entries()].map(([runnerId, r]) => ({
      runnerId,
      kind: r.kind,
      projects: r.projects,
      workspaceRoot: r.workspaceRoot,
      capabilities: r.capabilities,
    }));
  }

  /** Kind + location for a connected runner, for display metadata. */
  runnerInfo(runnerId: string): { kind: string; location: string | null } | undefined {
    const r = this.liveRunners.get(runnerId);
    return r ? { kind: r.kind, location: r.location } : undefined;
  }

  /** Scope fence: a dispatch cwd must be one of the runner's declared projects (or nested under
   *  one), or nested under its declared workspace root (clone-on-demand target). A runner that
   *  declared neither is unconfigured → permissive (back-compat). Declaring a workspaceRoot alone
   *  is enough to engage the fence, so a clone-on-demand runner with no pre-provisioned projects
   *  still rejects an out-of-tree cwd. */
  private cwdInScope(runnerId: string, cwd: string): boolean {
    const runner = this.liveRunners.get(runnerId);
    const projects = runner?.projects ?? [];
    const workspaceRoot = runner?.workspaceRoot ?? null;
    if (projects.length === 0 && !workspaceRoot) return true;
    if (workspaceRoot && (cwd === workspaceRoot || cwd.startsWith(`${workspaceRoot}/`))) return true;
    return projects.some((p) => cwd === p || cwd.startsWith(`${p}/`));
  }

  /** Clone-on-demand target: `<workspaceRoot>/<principal>/<owner>-<repo>`. The per-principal segment
   *  is the isolation seam — a no-op for the single-principal owner today, the confidentiality
   *  boundary once other principals dispatch. Throws if the runner declared no workspace root. */
  private cloneCwd(runnerId: string, principal: string, repo: RepoSpec): string {
    const workspaceRoot = this.liveRunners.get(runnerId)?.workspaceRoot;
    if (!workspaceRoot) {
      throw new Error(`runner "${runnerId}" does not support clone-on-demand (no workspace root declared)`);
    }
    return `${workspaceRoot}/${safePath(principal)}/${safePath(repo.owner)}-${safePath(repo.repo)}`;
  }

  /** Scratch target for a task with no repo (browsing, research): a fresh empty folder under the
   *  principal's workspace, `<workspaceRoot>/<principal>/scratch/<id>`. The runner creates it. */
  private scratchCwd(runnerId: string, principal: string): string {
    const workspaceRoot = this.liveRunners.get(runnerId)?.workspaceRoot;
    if (!workspaceRoot) throw new Error(`runner "${runnerId}" has no workspace for a task without a repo`);
    return `${workspaceRoot}/${safePath(principal)}/scratch/${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  }

  /** Runners that are online AND can service this request: for a clone-on-demand `repo`, any runner
   *  that declared a workspace root; for an existing `cwd`, any runner that declares that path. */
  eligibleRunners(intent: { repo?: RepoSpec | null; cwd?: string; scratch?: boolean; capability?: string }): string[] {
    return [...this.liveRunners.keys()].filter((id) => {
      if (!this.isRunnerLive(id)) return false;
      const runner = this.liveRunners.get(id);
      if (intent.capability && !runner?.capabilities.includes(intent.capability)) return false;
      if (intent.repo || intent.scratch) return runner?.workspaceRoot != null;
      return intent.cwd ? this.cwdInScope(id, intent.cwd) : false;
    });
  }

  /** Pick a runner when the caller didn't name one: the sole eligible runner, else a saved
   *  preference for this project, else report the ambiguous set for the caller to ask about. */
  selectRunner(
    principal: string,
    projectKey: string,
    intent: { repo?: RepoSpec | null; cwd?: string; scratch?: boolean; capability?: string },
  ): { runnerId: string; viaPref: boolean } | { ambiguous: string[] } | { none: true } {
    const eligible = this.eligibleRunners(intent);
    if (eligible.length === 0) return { none: true };
    if (eligible.length === 1) return { runnerId: eligible[0], viaPref: false };
    const pref = this.registry.getRoutingPref(principal, projectKey);
    if (pref && eligible.includes(pref)) return { runnerId: pref, viaPref: true };
    return { ambiguous: eligible };
  }

  /** Remember which runner a principal chose for a project, so it isn't asked again. */
  recordRoutingChoice(principal: string, projectKey: string, runnerId: string): void {
    this.registry.setRoutingPref(principal, projectKey, runnerId);
  }

  /** Authz-gates first (throws AuthzError if denied), then creates the task row and starts it.
   *  Returns once the task is created + started — events stream in asynchronously via onEvent. */
  async dispatch(input: DispatchInput): Promise<TaskRow> {
    const allowed = this.canFn({
      principal: input.principal,
      capability: "runner.dispatch",
      resource: input.runnerId,
      space: input.space,
      isPrivate: input.isPrivate,
    });
    if (!allowed) throw new AuthzError("runner.dispatch denied");

    this.ensureListening();

    const cwd = input.repo
      ? this.cloneCwd(input.runnerId, input.principal, input.repo)
      : input.cwd || this.scratchCwd(input.runnerId, input.principal);

    if (!this.cwdInScope(input.runnerId, cwd)) {
      throw new Error(`cwd "${cwd}" is not within any project the runner "${input.runnerId}" declared`);
    }

    const row = this.registry.create({
      createdBy: input.principal,
      runnerId: input.runnerId,
      project: input.project,
      cwd,
      nativeSessionId: null,
      resumeCursor: null,
      status: "running",
      statusReason: null,
      summary: null,
      spawnedFromSurface: input.spawnedFromSurface,
      threadRefs: input.threadRefs ?? [],
    });
    getActivityHub().open(row.id); // begin the live activity stream + mint its viewer token

    try {
      const result = (await this.server.start(input.runnerId, {
        taskId: row.id,
        cwd,
        prompt: input.prompt,
        repo: input.repo ?? null,
      })) as { nativeSessionId: string };
      this.registry.setNativeSession(row.id, result.nativeSessionId);
      const started = { ...row, nativeSessionId: result.nativeSessionId };
      this.emitStarted(started);
      return started;
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
      isPrivate: input.isPrivate,
    });
    if (!allowed) throw new AuthzError("session.resume denied");

    const task = this.registry.get(input.taskId);
    if (!task || task.createdBy !== input.principal) throw new AuthzError("session.resume denied");
    return this.resumeInternal(task, input.prompt);
  }

  /** Resume core — no authz. Only called after the caller authorized (canFn or a verified viewer token). */
  private async resumeInternal(task: TaskRow, prompt: string): Promise<TaskRow> {
    if (!task.nativeSessionId) throw new Error(`task ${task.id} has no native session to resume`);
    if (!this.isRunnerLive(task.runnerId)) throw new Error(`runner "${task.runnerId}" is not connected`);
    getActivityHub().open(task.id); // re-open the live stream for the resumed turn

    try {
      await this.server.resume(task.runnerId, {
        taskId: task.id,
        nativeSessionId: task.nativeSessionId,
        cwd: task.cwd ?? "", // empty → runner falls back (legacy rows predate the cwd column)
        prompt,
      });
    } catch (err) {
      logger.error({ err, taskId: task.id }, "failed to resume runner task");
      const current = this.registry.get(task.id);
      if (current && current.status !== "done" && current.status !== "failed") {
        this.registry.updateStatus(task.id, "failed", err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    this.registry.unarchive(task.id); // a resumed task rejoins the live roster
    const resumed = this.registry.get(task.id) as TaskRow;
    this.emitStarted(resumed);
    return resumed;
  }

  /** Halt the active run. Default keeps the task resumable (status idle, worktree + session kept);
   *  `discard` reclaims the worktree and marks it terminal. Idempotent — a settled/absent run just
   *  records the status. The runner's stop() suppresses any "failed" from the abort, so the status
   *  recorded here is authoritative. */
  async haltTask(input: HaltInput): Promise<TaskRow> {
    const allowed = this.canFn({ principal: input.principal, capability: "session.stop", resource: input.taskId, space: input.space, isPrivate: input.isPrivate });
    if (!allowed) throw new AuthzError("session.stop denied");
    const task = this.registry.get(input.taskId);
    if (!task || task.createdBy !== input.principal) throw new AuthzError("session.stop denied");
    return this.haltInternal(task, input.discard ?? false);
  }

  /** Halt core — no authz. Only called after the caller authorized. */
  private async haltInternal(task: TaskRow, discard: boolean): Promise<TaskRow> {
    if (this.isRunnerLive(task.runnerId)) {
      await this.server.stopTask(task.runnerId, { taskId: task.id, discard }).catch((err) => {
        logger.warn({ err, taskId: task.id }, "runner stop failed; recording status anyway");
      });
    }
    const status = discard ? "failed" : "idle";
    this.registry.updateStatus(task.id, status, discard ? "discarded by user" : "stopped by user");
    getActivityHub().settle(task.id, status, task.summary ?? null);
    return this.registry.get(task.id) as TaskRow;
  }

  /** Steer a running task: supersede its current turn and re-prompt with the guidance, preserving
   *  session context (this is `resume` with the steer text). The steer is recorded as an activity line
   *  so every watcher and the transcript sees the intervention. */
  async steer(input: SteerInput): Promise<TaskRow> {
    const allowed = this.canFn({ principal: input.principal, capability: "session.resume", resource: input.taskId, space: input.space, isPrivate: input.isPrivate });
    if (!allowed) throw new AuthzError("session.resume denied");
    const task = this.registry.get(input.taskId);
    if (!task || task.createdBy !== input.principal) throw new AuthzError("session.resume denied");
    return this.steerInternal(task, input.text);
  }

  private async steerInternal(task: TaskRow, text: string): Promise<TaskRow> {
    getActivityHub().append(task.id, `↪ steer: ${text}`, Date.now(), "text");
    // Prefer a live mid-run inject (Pi: sendUserMessage/steer — delivered after the current turn's
    // tool calls, before the next LLM call, no lost work). delivered:false (task not running, or a
    // one-shot runner like Claude Code) falls back to resume with the guidance as the prompt.
    if (this.isRunnerLive(task.runnerId)) {
      try {
        const res = (await this.server.message(task.runnerId, { taskId: task.id, text })) as { delivered?: boolean };
        if (res?.delivered) return this.registry.get(task.id) as TaskRow; // injected into the running turn; status unchanged
      } catch (err) {
        logger.warn({ err, taskId: task.id }, "live steer failed; falling back to resume");
      }
    }
    return this.resumeInternal(task, text);
  }

  /** Control a task from the token-gated live viewer. The unguessable per-task viewer token is the
   *  owner-auth (it never leaves the owner's DM / dispatch reply), so this skips canFn — the token IS
   *  the authorization — and acts as the task's owner. Verifies the token before doing anything. */
  async controlByToken(taskId: string, token: string, action: "stop" | "discard" | "resume" | "steer", text?: string): Promise<TaskRow> {
    if (!getActivityHub().viewWithToken(taskId, token)) throw new AuthzError("invalid task token");
    const task = this.registry.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    switch (action) {
      case "stop":
        return this.haltInternal(task, false);
      case "discard":
        return this.haltInternal(task, true);
      case "resume":
        return this.resumeInternal(task, text && text.trim() ? text : "Continue.");
      case "steer":
        if (!text || !text.trim()) throw new Error("steer requires text");
        return this.steerInternal(task, text);
    }
  }

  /** Persisted before any surface attempts delivery. The runner-supplied id makes a re-sent event
   *  idempotent. */
  storeAgentMessage(taskId: string, text: string, messageId?: string): TaskMessage {
    const task = this.registry.get(taskId);
    if (!task || !this.taskMessages) throw new Error("task messaging unavailable");
    const existing = messageId ? this.taskMessages.get(messageId) : undefined;
    if (existing) {
      if (existing.taskId !== taskId || existing.direction !== "agent_to_owner" || existing.content !== text) {
        throw new Error("task message id collision");
      }
      if (existing.status === "pending") this.emitTaskMessage(existing);
      return existing;
    }
    const message = this.taskMessages.create({ id: messageId, taskId, direction: "agent_to_owner", content: text });
    this.emitTaskMessage(message);
    return message;
  }

  onTaskMessage(listener: (message: TaskMessage) => void): void {
    this.taskMessageListeners.push(listener);
  }

  pendingTaskMessages(): TaskMessage[] {
    return this.taskMessages?.listPendingAgentMessages() ?? [];
  }

  markTaskMessageDelivered(id: string, discordMessageId: string | null): TaskMessage | undefined {
    if (!this.taskMessages) return undefined;
    this.taskMessages.markDelivered(id, discordMessageId);
    return this.taskMessages.get(id);
  }

  markTaskMessageFailed(id: string, failure: string): void {
    this.taskMessages?.markFailed(id, failure);
  }

  taskMessageForDiscordId(id: string): TaskMessage | undefined {
    return this.taskMessages?.findByDiscordMessageId(id);
  }

  private emitTaskMessage(message: TaskMessage): void {
    for (const listener of this.taskMessageListeners) {
      try { listener(message); } catch (err) { logger.error({ err, messageId: message.id }, "onTaskMessage listener threw"); }
    }
  }

  /** Owner reply delivered as ordinary inbound context, never through steer()/cancel(). */
  async replyToTaskMessage(input: { principal: string; messageId: string; text: string; space: string; isPrivate?: boolean }): Promise<TaskMessage> {
    const original = this.taskMessages?.get(input.messageId);
    const task = original && this.registry.get(original.taskId);
    if (!input.text.trim() || !original || original.direction !== "agent_to_owner" || original.status !== "delivered" || !task || task.createdBy !== input.principal) {
      throw new AuthzError("task message reply denied");
    }
    const allowed = this.canFn({ principal: input.principal, capability: "session.resume", resource: task.id, space: input.space, isPrivate: input.isPrivate });
    if (!allowed) throw new AuthzError("task message reply denied");
    const reply = this.taskMessages!.create({ taskId: task.id, direction: "owner_to_agent", content: input.text });
    if (task.status === "running") {
      try {
        if (!this.isRunnerLive(task.runnerId)) throw new Error(`runner "${task.runnerId}" is not connected`);
        const result = await this.server.followUp(task.runnerId, { taskId: task.id, text: input.text }) as { delivered?: boolean };
        if (!result?.delivered) throw new Error("runner cannot accept an ordinary follow-up while this task is running");
      } catch (err) {
        this.taskMessages!.markFailed(reply.id, err instanceof Error ? err.message : String(err));
        throw err;
      }
      this.taskMessages!.markDelivered(reply.id);
      return this.taskMessages!.get(reply.id)!;
    }
    if (task.status === "needs_input") {
      const reason = "task is waiting for an ask_owner answer; reply to its needs-input prompt instead";
      this.taskMessages!.markFailed(reply.id, reason);
      throw new Error(reason);
    }
    if (task.status === "idle") {
      // Resume internally—the message is already durably recorded as pending and will transition
      // once the runner accepts the normal inbound prompt.
      try {
        await this.resumeInternal(task, input.text);
        this.taskMessages!.markDelivered(reply.id);
        return this.taskMessages!.get(reply.id)!;
      } catch (err) {
        this.taskMessages!.markFailed(reply.id, err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
    const reason = `task is ${task.status} and cannot receive a reply`;
    this.taskMessages!.markFailed(reply.id, reason);
    throw new Error(reason);
  }

  /** Registers a callback invoked once per task turn SETTLING — {idle, done, failed} (per
   *  ARCHITECTURE.md's status model, a successful turn rests at idle, not done; done is reserved
   *  for explicit close). The Discord surface uses this to post a status line WITHOUT the
   *  dispatcher importing discord.js — the callback is the only seam. Listener errors are caught
   *  so one throwing surface can't break another or wedge event handling. */
  onTaskSettled(listener: (task: TaskRow) => void): void {
    this.settledListeners.push(listener);
  }

  /** A task began (dispatch or resume) and its live activity stream is open — the seam a surface
   *  uses to start a live progress view. discord.js-free, same as onTaskSettled. */
  onTaskStarted(listener: (task: TaskRow) => void): void {
    this.startedListeners.push(listener);
  }

  private emitStarted(task: TaskRow): void {
    for (const listener of this.startedListeners) {
      try {
        listener(task);
      } catch (err) {
        logger.error({ err, taskId: task.id }, "onTaskStarted listener threw");
      }
    }
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
        // Leaving needs_input (answered → running, or stopped) clears the pending ask on all surfaces.
        if (event.status !== "needs_input") getActivityHub().clearAsk(event.taskId);
        if (event.status === "idle" || event.status === "done" || event.status === "failed") {
          const updated = this.registry.get(event.taskId);
          getActivityHub().settle(event.taskId, event.status, updated?.summary ?? null);
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
      case "activity":
        getActivityHub().append(event.taskId, event.line, event.at, event.atype);
        return;
      case "ask":
        getActivityHub().setAsk(event.taskId, { askId: event.askId, question: event.question, choices: event.choices });
        return;
      case "owner_message":
        try { this.storeAgentMessage(event.taskId, event.text, event.messageId); }
        catch (err) { logger.error({ err, taskId: event.taskId, messageId: event.messageId }, "failed to persist agent task message"); }
        return;
      case "browser": {
        const { kind: _kind, taskId, ...update } = event;
        getActivityHub().pushBrowser(taskId, update);
        return;
      }
      case "handback":
        // The agent opens its own PR (via gh) when the task calls for it and names the link in its
        // summary, so the summary is stored as-authored.
        this.registry.setSummary(event.taskId, event.summary);
        return;
    }
  }

  listRunning(principal: string): TaskRow[] {
    return this.registry
      .listByPrincipal(principal)
      .filter((t) => t.archivedAt === null && (t.status === "running" || t.status === "idle"));
  }

  /** Archive settled tasks idle longer than `ttlDays` so the roster stays legible. Called on boot
   *  and on an interval by the surface. Archived tasks stay resumable (resume un-archives them). */
  archiveStaleTasks(ttlDays: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400;
    const n = this.registry.archiveIdleBefore(cutoff);
    if (n > 0) logger.info({ archived: n, ttlDays }, "archived stale idle tasks");
    return n;
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
      const db = getDb();
      singleton = new Dispatcher(new TaskRegistry(db), can, { port }, new TaskMessageStore(db));
    } catch (err) {
      startupFailed = true;
      logger.error({ err }, "orchestration dispatcher failed to start; runner tools disabled for this process");
      throw new DispatcherUnavailableError("orchestration dispatcher failed to start");
    }
  }
  return singleton;
}
