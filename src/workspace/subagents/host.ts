import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentSession, AgentSessionEvent, AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ConcurrencyLimiter } from "../../../vendor/pi-subagents/src/lifecycle/concurrency-limiter.ts";
import { createChildLifecyclePublisher } from "../../../vendor/pi-subagents/src/lifecycle/child-lifecycle.ts";
import type { CreateSubagentSessionParams } from "../../../vendor/pi-subagents/src/lifecycle/create-subagent-session.ts";
import type { ParentSnapshot } from "../../../vendor/pi-subagents/src/lifecycle/parent-snapshot.ts";
import { SubagentManager, type SpawnTypeResolver } from "../../../vendor/pi-subagents/src/lifecycle/subagent-manager.ts";
import { SubagentSession } from "../../../vendor/pi-subagents/src/lifecycle/subagent-session.ts";
import type { AgentConfig } from "../../../vendor/pi-subagents/src/types.ts";
import { RPC_METHODS, type ChatEventParams, type ChatEventPayload } from "../../orchestration/contracts.ts";
import { assertExactTools, createOpenRouterModel } from "../../orchestration/runner/piShared.ts";
import { runnerGit } from "../../orchestration/runner/runnerGit.ts";
import { getLogger } from "../../logger.ts";
import type { WorkspaceConfig } from "../config.ts";
import { mapSessionEvent, newRunAccumulator, type RunAccumulator } from "../events.ts";
import { createMemoryGuardExtension } from "../memoryGuard.ts";
import { createCompactionHandoffExtension } from "../memoryFlush.ts";
import { createWorkspaceBashTool } from "../piChatSession.ts";
import type { RunRecorder, RunStatus } from "../runLog.ts";
import { createSecretGuardExtension } from "../secretGuard.ts";
import { SESSION_DIRS, subagentSessionDir } from "../sessionPaths.ts";
import { KNOWN_PROXIED_TOOLS, type ToolStubs } from "../toolStubs.ts";
import { ulid } from "../ulid.ts";
import { loadAgentDefs, type AgentDef } from "./agentDefs.ts";
import { ChildSlots, type SlotKind } from "./slots.ts";
import type { ParentTurn } from "./turnTracker.ts";

const log = getLogger("workspace.subagents");
const guardLog = getLogger("workspace.guard");
const memoryLog = getLogger("workspace.memory");

export const DELEGATE_TOOL = "delegate";
const PROVIDER_ID = "sushii-subagent-openrouter";
export const RESULT_CUSTOM_TYPE = "subagent-result";

type SettledStatus = Exclude<RunStatus, "running">;

export interface SubagentLimits {
  /** Delegation levels below main; 1 makes every child a leaf. */
  maxDepth: number;
  maxReaders: number;
  maxWriters: number;
  maxTurns: number;
  /** Turns after the "wrap up" steer before a hard abort. */
  graceTurns: number;
  foregroundTimeoutMs: number;
  backgroundTimeoutMs: number;
  /** Input + output tokens across the child's run. */
  maxTokens: number;
  /** Only enforced where Pi reports a price (ChatGPT and our OpenRouter registration report none). */
  maxCostUsd: number;
  resultChars: number;
}

export const DEFAULT_LIMITS: SubagentLimits = {
  maxDepth: 1,
  maxReaders: 3,
  maxWriters: 1,
  maxTurns: 40,
  graceTurns: 3,
  foregroundTimeoutMs: 10 * 60_000,
  backgroundTimeoutMs: 60 * 60_000,
  maxTokens: 3_000_000,
  maxCostUsd: 2,
  resultChars: 6000,
};

export interface SubagentHostOptions {
  config: WorkspaceConfig;
  runs: RunRecorder;
  toolStubs?: ToolStubs;
  /** The main turn in progress; child progress nests under it. */
  currentTurn?: () => ParentTurn | null;
  /** Sends chat/event notifications to the bot. */
  notify?: (method: string, params: unknown) => void;
  limits?: Partial<SubagentLimits>;
}

/** Where a delegate tool is mounted: main (depth 0) or a nested child. */
export interface DelegateParent {
  depth: number;
  /** The run in progress on the parent session; the children's parentRunId. */
  currentRunId: () => string | null;
}

interface DelegateArgs {
  agent?: string;
  task: string;
  mode?: "fresh" | "fork";
  continue?: string;
  background?: boolean;
  repo?: string;
}

type PiSessionManager = import("@earendil-works/pi-coding-agent").SessionManager;

/** Everything one spawn carries into the session factory, keyed by its (per-spawn) snapshot object. */
interface Spawn {
  runId: string;
  parentRunId: string;
  def: AgentDef;
  depth: number;
  background: boolean;
  sessionManager: PiSessionManager;
  sessionFile: string;
  turn: ParentTurn | null;
  acc: RunAccumulator;
  capHit: "timeout" | "tokens" | "cost" | "turns" | null;
  turns: number;
  /** turn_start was sent, so a turn_end is owed. */
  started: boolean;
  abortChild: (() => void) | null;
  worktree?: { path: string; branch: string };
}

export interface DelegateOutcome {
  runId: string;
  status: RunStatus;
  text: string;
}

/** Subagents for the workspace: an adopted pi-subagents lifecycle core behind our own `delegate` tool. */
export class SubagentHost {
  readonly limits: SubagentLimits;
  private readonly opts: SubagentHostOptions;
  private readonly slots: ChildSlots;
  private readonly spawns = new WeakMap<ParentSnapshot, Spawn>();
  private readonly defsBySpawn = new Map<string, AgentDef>();
  private readonly activeFiles = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly models = new Map<string, ReturnType<typeof createOpenRouterModel>>();
  private readonly manager: SubagentManager;
  private mainPi: ExtensionAPI | null = null;
  private disposed = false;

  constructor(opts: SubagentHostOptions) {
    this.opts = opts;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.slots = new ChildSlots({ reader: this.limits.maxReaders, writer: this.limits.maxWriters });
    const registry: SpawnTypeResolver = {
      resolveType: (name) => (this.defsBySpawn.has(name) ? name : undefined),
      isValidType: (name) => this.defsBySpawn.has(name),
      resolveAgentConfig: (name) => agentConfig(this.defsBySpawn.get(name)),
    };
    this.manager = new SubagentManager({
      createSubagentSession: (params) => this.createChildSession(params),
      // Our ChildSlots gate every spawn before it reaches the manager, so its own queue stays unused.
      limiter: new ConcurrencyLimiter(() => Number.POSITIVE_INFINITY),
      baseCwd: opts.config.home,
      getRunConfig: () => ({ defaultMaxTurns: this.limits.maxTurns, graceTurns: this.limits.graceTurns, midRunUpdates: false }),
      registry,
    });
  }

  /** Extension factory that registers `delegate` on a session at `parent.depth`; a no-op at the depth cap. */
  extension(parent: DelegateParent): ExtensionFactory {
    return (pi) => {
      if (parent.depth >= this.limits.maxDepth) return;
      if (parent.depth === 0) this.mainPi = pi;
      pi.registerTool(this.toolDefinition(parent, pi));
    };
  }

  /** Whether a session at `depth` gets the delegate tool. */
  offersDelegate(depth: number): boolean {
    return depth < this.limits.maxDepth;
  }

  /** Aborts every child and waits for their runs to be recorded. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.slots.rejectWaiting(new Error("the workspace is shutting down"));
    this.manager.abortAll();
    await Promise.allSettled([...this.pending]);
    await this.manager.dispose();
  }

  private toolDefinition(parent: DelegateParent, pi: ExtensionAPI): ToolDefinition {
    const defs = loadAgentDefs(this.opts.config.home);
    const agentList = [...defs.values()].map((d) => `- ${d.name}${d.writer ? " (writer)" : ""}: ${d.description}`).join("\n") || "- (none defined)";
    const cap = this.limits.resultChars;
    return {
      name: DELEGATE_TOOL,
      label: "delegate",
      promptSnippet: "delegate: hand bulky or independent work to a subagent with a fresh context; only its summary comes back",
      description:
        `Run a subagent with its own fresh context and get back only its summary (at most ${cap} chars) plus a runId. ` +
        "Use it for work that would flood your context: exploring a codebase or many files, web research, log/trace " +
        "digging, a fresh-eyes review, multi-step coding in a repo. The child's transcript stays out of your context; " +
        "read it later with `ws-runs show <runId>` if you need detail.\n\n" +
        `Agents (from ~/.agents/agents/):\n${agentList}\n\n` +
        "Write a complete brief in `task`: goal, what you already know, what to return. With mode \"fresh\" (default) " +
        "the child sees nothing else; mode \"fork\" starts it from a copy of this conversation. `continue` with a " +
        "finished child's runId sends it a follow-up in its own session. `background: true` returns at once; the " +
        "result arrives later as a message. Children can't ask questions, message drk, or write memory files. " +
        `At most ${this.limits.maxReaders} read-only children and ${this.limits.maxWriters} writer run at once; ` +
        "writers need `repo` (a git repo under projects/) and work in their own worktree on a new branch.",
      parameters: Type.Object({
        agent: Type.Optional(Type.String({ description: "Agent name; required unless `continue` is set." })),
        task: Type.String({ description: "The complete brief (or, with `continue`, the follow-up)." }),
        mode: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fresh (default) or fork" })),
        continue: Type.Optional(Type.String({ description: "runId of a finished child to prompt again." })),
        background: Type.Optional(Type.Boolean({ description: "Return at once; the result is delivered later." })),
        repo: Type.Optional(Type.String({ description: "For writer agents: the repo directory under projects/." })),
      }) as ToolDefinition["parameters"],
      execute: async (toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
        const out = await this.delegate(params as DelegateArgs, { parent, pi, toolCallId, signal, ctx });
        return { content: [{ type: "text", text: out.text }], details: { runId: out.runId, status: out.status } } satisfies AgentToolResult<unknown>;
      },
    } as ToolDefinition;
  }

  /** One delegate call: resolve, record the run, then run it (foreground) or schedule it (background). */
  async delegate(
    args: DelegateArgs,
    call: { parent: DelegateParent; pi: ExtensionAPI; toolCallId: string; signal?: AbortSignal; ctx: Pick<ExtensionContext, "sessionManager"> },
  ): Promise<DelegateOutcome> {
    if (this.disposed) throw new Error("the workspace is shutting down");
    const parentRunId = call.parent.currentRunId();
    if (!parentRunId) throw new Error("delegate: no parent run in progress");
    const task = args.task?.trim();
    if (!task) throw new Error("delegate: `task` is empty");
    const depth = call.parent.depth + 1;

    const { def, sessionManager, worktree } = args.continue ? await this.planContinue(args.continue) : await this.planNew(args, call, parentRunId);
    // Nested children run in the foreground: their parent's session is gone once it returns.
    const background = call.parent.depth === 0 && (args.background ?? def.background);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("delegate: the child session has no file");
    this.activeFiles.add(resolve(sessionFile));
    const spawnKey = `${def.name}#${ulid()}`;
    this.defsBySpawn.set(spawnKey, def);

    const snapshot: ParentSnapshot = { cwd: sessionManager.getCwd(), systemPrompt: "", model: undefined, modelRegistry: { find: () => undefined, getAll: () => [] } };
    const spawn: Spawn = {
      runId: "",
      parentRunId,
      def,
      depth,
      background,
      sessionManager,
      sessionFile,
      turn: this.opts.currentTurn?.() ?? null,
      acc: newRunAccumulator(),
      capHit: null,
      turns: 0,
      started: false,
      abortChild: null,
      ...(worktree ? { worktree } : {}),
    };
    spawn.runId = this.opts.runs.startRun({ agentName: def.name, parentRunId, task, sessionFile });
    this.spawns.set(snapshot, spawn);
    log.info({ runId: spawn.runId, parentRunId, agent: def.name, background, mode: args.continue ? "continue" : (args.mode ?? "fresh") }, "subagent spawned");

    const kind: SlotKind = def.writer ? "writer" : "reader";
    const queued = this.slots.running(kind) >= this.limits[kind === "writer" ? "maxWriters" : "maxReaders"];
    const run = this.runSpawn(spawnKey, snapshot, spawn, task, kind, background ? undefined : call.signal);
    if (!background) {
      const outcome = await run;
      return outcome;
    }
    const tracked = run
      .then((outcome) => this.deliverBackground(spawn, outcome))
      .catch((err) => log.error({ err, runId: spawn.runId }, "background subagent failed"));
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
    return {
      runId: spawn.runId,
      status: "running",
      text:
        `Started ${def.name} in the background (runId ${spawn.runId}${queued ? ", queued for a free slot" : ""}). ` +
        "Its result will arrive as a message; tell drk it's running and carry on.",
    };
  }

  private async runSpawn(spawnKey: string, snapshot: ParentSnapshot, spawn: Spawn, task: string, kind: SlotKind, signal: AbortSignal | undefined): Promise<DelegateOutcome> {
    let release: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: SettledStatus = "failed";
    let text = "";
    try {
      release = await this.slots.acquire(kind, signal);
      if (this.disposed) throw new Error("the workspace is shutting down");
      const id = this.manager.spawn(snapshot, spawnKey, task, {
        description: spawn.def.name,
        maxTurns: spawn.def.maxTurns ?? this.limits.maxTurns,
        background: { kind: "explicit", isBackground: false },
        bypassQueue: true,
        signal,
      });
      const record = this.manager.getRecord(id)!;
      const timeoutMs = spawn.background ? this.limits.backgroundTimeoutMs : this.limits.foregroundTimeoutMs;
      timer = setTimeout(() => this.hitCap(spawn, "timeout"), timeoutMs);
      await record.promise;
      text = (record.result ?? record.error ?? "").trim();
      status = outcomeStatus(record.status, spawn.capHit);
      await record.releaseSession();
    } catch (err) {
      text = err instanceof Error ? err.message : String(err);
      status = signal?.aborted ? "aborted" : "failed";
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
      this.defsBySpawn.delete(spawnKey);
      this.activeFiles.delete(resolve(spawn.sessionFile));
      void this.manager.clearCompleted();
    }
    if (spawn.started) this.emit(spawn, { type: "turn_end", aborted: status !== "done" });
    try {
      this.opts.runs.endRun(spawn.runId, {
        status,
        usage: { inputTokens: spawn.acc.inputTokens, outputTokens: spawn.acc.outputTokens, costUsd: spawn.acc.costUsd },
        ...(text ? { resultSummary: text } : {}),
      });
    } catch (err) {
      log.error({ err, runId: spawn.runId }, "failed to record the end of a subagent run");
    }
    log.info({ runId: spawn.runId, agent: spawn.def.name, status, inputTokens: spawn.acc.inputTokens, outputTokens: spawn.acc.outputTokens }, "subagent settled");
    return { runId: spawn.runId, status, text: this.resultText(spawn, status, text) };
  }

  private hitCap(spawn: Spawn, cap: NonNullable<Spawn["capHit"]>): void {
    if (spawn.capHit) return;
    spawn.capHit = cap;
    log.warn({ runId: spawn.runId, cap }, "subagent hit a cap; aborting it");
    spawn.abortChild?.();
  }

  private resultText(spawn: Spawn, status: RunStatus, raw: string): string {
    const cap = this.limits.resultChars;
    const body = raw.length > cap ? `${raw.slice(0, cap)}\n[… cut at ${cap} of ${raw.length} chars; full text in the transcript]` : raw || "(no reply)";
    const why = spawn.capHit ? ` (${capReason(spawn.capHit)})` : "";
    const head = `[${spawn.def.name} · runId ${spawn.runId} · ${status}${why}]`;
    const wt = spawn.worktree ? `\nWorktree: ${spawn.worktree.path} (branch ${spawn.worktree.branch})` : "";
    return `${head}\n${body}${wt}\nFull transcript: ws-runs show ${spawn.runId}`;
  }

  private deliverBackground(spawn: Spawn, outcome: DelegateOutcome): void {
    const pi = this.mainPi;
    if (!pi || this.disposed) return;
    const content = `<subagent-result runId="${outcome.runId}" agent="${spawn.def.name}" status="${outcome.status}">\n${outcome.text}\n</subagent-result>`;
    try {
      pi.sendMessage({ customType: RESULT_CUSTOM_TYPE, content, display: true, details: { runId: outcome.runId, status: outcome.status } }, { deliverAs: "followUp", triggerTurn: true });
    } catch (err) {
      log.warn({ err, runId: outcome.runId }, "could not wake the main session with a background result; it stays in runs.jsonl");
    }
  }

  private async planNew(
    args: DelegateArgs,
    call: { toolCallId: string; ctx: Pick<ExtensionContext, "sessionManager"> },
    parentRunId: string,
  ): Promise<{ def: AgentDef; sessionManager: PiSessionManager; worktree?: { path: string; branch: string } }> {
    const defs = loadAgentDefs(this.opts.config.home);
    const def = args.agent ? defs.get(args.agent) : undefined;
    if (!def) throw new Error(`delegate: unknown agent ${JSON.stringify(args.agent ?? "")}; available: ${[...defs.keys()].join(", ") || "none"}`);
    const dir = subagentSessionDir(this.opts.config.agentDir, parentRunId);
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const fork = args.mode === "fork" ? forkSource(call.ctx.sessionManager, call.toolCallId) : null;
    let cwd = this.opts.config.home;
    let worktree: { path: string; branch: string } | undefined;
    if (def.writer) {
      worktree = await this.createWorktree(args.repo);
      cwd = worktree.path;
    }
    if (!fork) return { def, worktree, sessionManager: SessionManager.create(cwd, dir) };
    // A separate manager on the parent's file: createBranchedSession repoints the manager it runs on, and
    // writes root→leaf into `dir` with the parent file as its parentSession.
    const sessionManager = SessionManager.open(fork.file, dir, cwd);
    sessionManager.createBranchedSession(fork.leaf);
    return { def, worktree, sessionManager };
  }

  private async planContinue(runId: string): Promise<{ def: AgentDef; sessionManager: PiSessionManager; worktree?: undefined }> {
    const rec = this.opts.runs.getRun(runId);
    if (!rec || !rec.parentRunId) throw new Error(`delegate: no subagent run ${runId}`);
    if (rec.status === "running") throw new Error(`delegate: run ${runId} is still running`);
    const root = resolve(this.opts.config.agentDir, SESSION_DIRS.subagents);
    const file = resolve(rec.sessionFile);
    if (!file.startsWith(root + sep) || !existsSync(file)) throw new Error(`delegate: run ${runId} has no subagent session file`);
    if (this.activeFiles.has(file)) throw new Error(`delegate: run ${runId}'s session is in use by another child`);
    const def = loadAgentDefs(this.opts.config.home).get(rec.agentName);
    if (!def) throw new Error(`delegate: agent ${rec.agentName} of run ${runId} no longer exists`);
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    // No cwd override: the header keeps a writer's worktree.
    return { def, sessionManager: SessionManager.open(file, dirname(file)) };
  }

  private async createWorktree(repo: string | undefined): Promise<{ path: string; branch: string }> {
    if (!repo || !/^[A-Za-z0-9._-]+$/.test(repo) || repo.startsWith(".")) throw new Error("delegate: writer agents need `repo`, a directory name under projects/");
    const projects = join(this.opts.config.home, "projects");
    const src = join(projects, repo);
    if (!existsSync(join(src, ".git"))) throw new Error(`delegate: projects/${repo} is not a git repo`);
    const id = ulid().toLowerCase();
    const path = join(projects, `${repo}-wt-${id}`);
    const branch = `agent/${id}`;
    await runnerGit(src).raw(["worktree", "add", "-b", branch, path]);
    return { path, branch };
  }

  private model(id: string | undefined) {
    const key = id ?? this.opts.config.model;
    let m = this.models.get(key);
    if (!m) {
      const { config } = this.opts;
      m = createOpenRouterModel({ agentDir: config.agentDir, providerId: PROVIDER_ID, providerName: "sushii subagent OpenRouter", model: key, apiKey: config.apiKey, baseUrl: config.baseUrl });
      m.catch(() => this.models.delete(key));
      this.models.set(key, m);
    }
    return m;
  }

  private emit(spawn: Spawn, ev: ChatEventPayload): void {
    if (!spawn.turn || !this.opts.notify) return;
    const params: ChatEventParams = {
      ...(spawn.turn.origin ? { origin: spawn.turn.origin } : {}),
      principalId: this.opts.config.principalId,
      turnId: spawn.turn.turnId,
      agentId: spawn.runId,
      parentRunId: spawn.parentRunId,
      ev,
    };
    try {
      this.opts.notify(RPC_METHODS.chatEvent, params);
    } catch (err) {
      log.debug({ err }, "subagent chat/event not sent");
    }
  }

  /** The session factory the adopted SubagentManager calls: our tools, guards and session file per mode. */
  private async createChildSession(params: CreateSubagentSessionParams): Promise<SubagentSession> {
    const spawn = this.spawns.get(params.snapshot);
    if (!spawn) throw new Error("subagent spawned without a spawn context");
    const { config } = this.opts;
    const { createAgentSession, DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { modelRuntime, model, maxTokens } = await this.model(spawn.def.model);
    const sessionManager = spawn.sessionManager;
    const cwd = sessionManager.getCwd();
    const file = spawn.sessionFile;

    const stubs = this.opts.toolStubs?.binding({ agentId: spawn.runId, agentName: spawn.def.name, parentRunId: spawn.parentRunId });
    const nested = this.offersDelegate(spawn.depth);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: config.agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => childSystemPrompt(spawn, cwd, config.home, this.limits.resultChars),
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        { name: "sushii-secret-guard", factory: createSecretGuardExtension({ agentDir: config.agentDir, cwd, home: config.home, log: guardLog }) },
        ...(stubs ? [{ name: "sushii-tool-stubs", factory: stubs.factory }] : []),
        { name: "sushii-memory-guard", factory: createMemoryGuardExtension({ home: config.home, cwd, readOnly: true, log: memoryLog }) },
        // Rooted in the child's scratch dir, so its compaction handoff never lands in drk's daily notes.
        { name: "sushii-compaction-handoff", factory: createCompactionHandoffExtension({ home: join(config.home, "scratch", "subagents", spawn.runId), log: memoryLog }) },
        ...(nested ? [{ name: "sushii-delegate", factory: this.extension({ depth: spawn.depth, currentRunId: () => spawn.runId }) }] : []),
      ],
    });

    let session: AgentSession;
    try {
      await loader.reload();
      const settingsManager = SettingsManager.create(cwd, config.agentDir);
      settingsManager.applyOverrides({ compaction: { reserveTokens: maxTokens } });
      settingsManager.getCacheWarmingMode = () => "off";
      const builtins = spawn.def.tools;
      const extra = [...(nested ? [DELEGATE_TOOL] : [])];
      const customTools = builtins.includes("bash") ? [await createWorkspaceBashTool(cwd, () => spawn.runId)] : [];
      ({ session } = await createAgentSession({
        cwd,
        agentDir: config.agentDir,
        model,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        tools: [...builtins, ...extra, ...(stubs ? KNOWN_PROXIED_TOOLS : [])],
        customTools,
        excludeTools: ["ask_question"],
        sessionManager,
      }));
      assertExactTools(session, [...builtins, ...extra, ...(stubs?.registeredNames() ?? [])], `subagent ${spawn.def.name}`, [...builtins, ...extra, ...(stubs?.offered() ?? [])]);
      stubs?.assertOwned(session, `subagent ${spawn.def.name}`);
    } catch (err) {
      stubs?.release();
      throw err;
    }

    const unsubscribe = session.subscribe((event) => this.onChildEvent(spawn, event));
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      try {
        unsubscribe();
        return dispose();
      } finally {
        stubs?.release();
      }
    };
    spawn.abortChild = () => void session.abort();
    if (spawn.capHit) spawn.abortChild();
    spawn.started = true;
    this.emit(spawn, { type: "turn_start" });

    return new SubagentSession(session, {
      outputFile: file,
      sessionId: sessionManager.getSessionId(),
      sessionDir: dirname(file),
      agentName: spawn.def.name,
      agentMaxTurns: spawn.def.maxTurns,
      parentContext: undefined,
      lifecycle: createChildLifecyclePublisher((channel, data) => log.debug({ channel, data }, "subagent lifecycle")),
    });
  }

  private onChildEvent(spawn: Spawn, event: AgentSessionEvent): void {
    for (const ev of mapSessionEvent(event, spawn.acc)) {
      if (ev.type === "tool_start" || ev.type === "tool_end") this.emit(spawn, ev);
    }
    // The adopted turn loop steers at the cap and aborts after the grace turns; this only labels that abort.
    if (event.type === "turn_end" && ++spawn.turns >= (spawn.def.maxTurns ?? this.limits.maxTurns) + this.limits.graceTurns && !spawn.capHit) {
      spawn.capHit = "turns";
    }
    if (event.type !== "message_end") return;
    if (spawn.acc.inputTokens + spawn.acc.outputTokens > this.limits.maxTokens) this.hitCap(spawn, "tokens");
    else if (spawn.acc.costUsd > this.limits.maxCostUsd) this.hitCap(spawn, "cost");
  }
}

/** The vendored manager's view of one of our defs; the turn cap is the only field it acts on. */
function agentConfig(def: AgentDef | undefined): AgentConfig {
  return {
    name: def?.name ?? "subagent",
    description: def?.description ?? "",
    systemPrompt: def?.prompt ?? "",
    promptMode: "replace",
    toolNames: def?.tools ?? [],
    ...(def?.maxTurns ? { maxTurns: def.maxTurns } : {}),
  };
}

/** Maps the vendored record status (and our own caps) onto the run log's. */
export function outcomeStatus(status: string, capHit: Spawn["capHit"]): SettledStatus {
  if (capHit === "timeout") return "timeout";
  if (capHit) return "aborted";
  if (status === "completed" || status === "steered") return "done";
  if (status === "error") return "failed";
  return "aborted";
}

function capReason(cap: NonNullable<Spawn["capHit"]>): string {
  if (cap === "timeout") return "hit its wall-clock cap";
  if (cap === "tokens") return "hit its token cap";
  if (cap === "turns") return "hit its turn cap";
  return "hit its cost cap";
}

/** The parent file and the entry to fork from: the one before the assistant message that issued
 *  `toolCallId`, which has no tool result yet. */
export function forkSource(sm: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionFile">, toolCallId: string): { file: string; leaf: string } {
  const file = sm.getSessionFile();
  if (!file || !existsSync(file)) throw new Error("delegate: fork needs a persisted parent session");
  const branch = sm.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as { type: string; parentId: string | null; message?: { role?: string; content?: unknown } };
    if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
    const calls = e.message.content as Array<{ type?: string; id?: string }>;
    if (!calls.some((c) => c?.type === "toolCall" && c.id === toolCallId)) continue;
    if (!e.parentId) throw new Error("delegate: nothing to fork before this call");
    return { file, leaf: e.parentId };
  }
  throw new Error("delegate: the calling message is not in the parent session yet");
}

function childSystemPrompt(spawn: Spawn, cwd: string, home: string, cap: number): string {
  const where = relative(home, cwd) || ".";
  return [
    spawn.def.prompt,
    "",
    "## Subagent rules",
    `You are the \`${spawn.def.name}\` subagent (runId ${spawn.runId}), working for drk's personal agent, not for drk directly.`,
    `Your final message is your result: the main agent sees only it, cut at ${cap} chars. Make it a self-contained summary with concrete findings (paths, commands, links).`,
    "You can't ask questions or message anyone; if something is ambiguous, state your assumption and carry on.",
    "You can't write USER.md, MEMORY.md or memory/; put anything worth remembering in your result.",
    `Working directory: ~/${where === "." ? "" : where} (home is ${home}). Use scratch/subagents/${spawn.runId}/ for any files you produce.`,
    `Date: ${new Date().toISOString().slice(0, 10)}.`,
  ].join("\n");
}
