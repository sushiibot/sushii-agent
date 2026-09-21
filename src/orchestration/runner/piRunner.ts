import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HandbackMeta, RepoSpec, RunnerAdapter, RunnerEvent } from "../contracts.ts";
import { getLogger } from "../../logger.ts";
import { RunnerEventReducer, type StreamLineEvent } from "./claudeCodeRunner.ts";
import { agentGitEnv, cloneIfAbsent, configureForAgent, ensureWorktree, pruneWorktrees, type RepoOpsDeps } from "./repoOps.ts";

const log = getLogger("orchestration.runner.pi");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODEL_METADATA_TIMEOUT_MS = 5000;
const PROVIDER_ID = "sushii-runner-openrouter";

// Generic coding-runner system prompt. The trailing summary instruction is what makes the handback
// informative — without it a model that does its work purely via tools stops with no final text, so
// the handback recap comes back empty ("Stopped."). Kept minimal + agent-agnostic (no wiki/Discord).
const RUNNER_SYSTEM_PROMPT = `You are an autonomous coding agent working in a git repository. Carry out the requested task directly using your tools (read, edit, write, bash, etc.).

Git & GitHub: your shell is already authenticated for this repository (git push and the gh CLI both work), and you are already on a fresh dedicated task branch cut from the latest default branch — do NOT create another branch, and never push to the default branch (it is blocked). Use git/gh yourself, and only when the task calls for it — not every task needs a commit or a PR. Typical flow when you have changes to publish: commit them, push the current branch with \`git push -u origin HEAD\`, and open a pull request with \`gh pr create\` (use --draft unless told otherwise). If the task is exploratory, a question, or needs no change, do none of that. When you finish, end your turn with a concise one- or two-sentence summary of what you did — including the PR link if you opened one — or state plainly that nothing needed changing.`;

export interface PiRunnerOptions {
  model: string;
  apiKey: string;
  baseUrl: string;
  agentDir: string; // where Pi keeps auth/models/sessions (session files = resume handles)
  maxOutputTokens?: number;
  fallbackContextWindow?: number;
  progressDebounceMs?: number;
  now?: () => number;
  // Clone-on-demand + runner-side push. When unset, a dispatch carrying a repo still runs (the cwd
  // must already be a checkout) but nothing is cloned or pushed.
  repoOps?: RepoOpsDeps;
  // Task-worktree GC. workspaceRoot enables it; TTL/interval have sane defaults.
  workspaceRoot?: string | null;
  worktreeTtlMs?: number;
  gcIntervalMs?: number;
}

/**
 * Resolve the model's real context window from OpenRouter's catalog so max_tokens is capped under
 * the true ceiling. Ported verbatim from wiki-sync's piSession — setting max_tokens to the full
 * context window (what OpenRouter reports as max_completion_tokens) makes every prompt overflow and
 * get silently rejected. Falls back to a safe buffer on any fetch/parse failure.
 */
async function resolveContextWindow(modelId: string, fallback: number): Promise<number> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OpenRouter models catalog returned ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
    const entry = payload.data?.find((m) => m.id === modelId);
    if (!entry?.context_length || entry.context_length <= 0) throw new Error(`model ${modelId} missing context_length`);
    return entry.context_length;
  } catch (err) {
    log.warn({ modelId, err, fallback }, "failed to resolve context window from OpenRouter catalog; using fallback");
    return fallback;
  }
}

// Prefer the human-meaningful field of a tool's args for the activity line (the command, the path,
// the pattern), else compact JSON. Truncation happens downstream in activityLine.
function summarizeToolArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of ["command", "path", "file_path", "pattern", "query", "url"]) {
      if (typeof a[k] === "string" && a[k]) return a[k] as string;
    }
    // Fallback: a compact key=value of scalar fields, never a raw JSON object dump.
    const parts = Object.entries(a)
      .filter(([, v]) => v != null && typeof v !== "object")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
    return parts.join(" ");
  }
  return "";
}

// Prefer a tool result's human-readable payload (a command's stdout, a file's text) over a raw JSON
// dump, so the activity log reads like output rather than a serialized object.
function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.stdout === "string" || typeof r.stderr === "string") {
      return [r.stdout, r.stderr].filter((s) => typeof s === "string" && s).join("\n");
    }
    for (const k of ["output", "text", "content", "message", "result"]) {
      if (typeof r[k] === "string" && r[k]) return r[k] as string;
    }
    // Structured object without a text payload: a compact key=value, not a raw JSON dump.
    const parts = Object.entries(r)
      .filter(([, v]) => v != null && typeof v !== "object")
      .slice(0, 4)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
    if (parts.length) return parts.join(" ");
  }
  try {
    return JSON.stringify(result).slice(0, 200);
  } catch {
    return String(result);
  }
}

// Accumulates per-turn state the reducer's terminal "result" signal needs — Pi surfaces the final
// text as deltas and usage only on the "done" event, so we carry them until prompt() resolves.
interface TurnAccumulator {
  finalText: string;
  tokens: number | undefined;
}

/**
 * Maps one Pi AgentSessionEvent onto the same StreamLineEvent vocabulary the claude-code runner's
 * RunnerEventReducer already consumes (tool_use / assistant_text), so both kinds share one reducer.
 * Pure except for mutating the accumulator; the terminal "result" signal is synthesized separately
 * when session.prompt() resolves (Pi has no single "run finished" event — a turn just stops).
 */
export function piEventToSignals(event: AgentSessionEvent, acc: TurnAccumulator): StreamLineEvent[] {
  if (event.type === "tool_execution_start") {
    return [{ type: "tool_use", name: event.toolName, detail: summarizeToolArgs(event.args) }];
  }
  if (event.type === "tool_execution_end") {
    return [{ type: "tool_result", name: event.toolName, output: stringifyResult(event.result), isError: event.isError === true }];
  }
  if (event.type === "message_update") {
    const m = event.assistantMessageEvent;
    if (m.type === "text_delta") {
      acc.finalText += m.delta ?? "";
    } else if (m.type === "text_end") {
      return [{ type: "assistant_text", text: m.content }];
    } else if (m.type === "done") {
      const usage = m.message?.usage;
      if (usage) acc.tokens = (usage.input ?? 0) + (usage.output ?? 0);
    }
  }
  return [];
}

// Minimal async queue of reducer signals — the in-process analog of claudeCodeRunner's LineChannel
// (which queues stdout text lines). stream() drains it; the prompt runner pushes into it.
class SignalQueue {
  private readonly queue: StreamLineEvent[] = [];
  private readonly waiting: ((v: IteratorResult<StreamLineEvent>) => void)[] = [];
  private closed = false;

  push(sig: StreamLineEvent): void {
    const w = this.waiting.shift();
    if (w) w({ value: sig, done: false });
    else this.queue.push(sig);
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length) this.waiting.shift()!({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<StreamLineEvent>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as StreamLineEvent, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

interface PiTaskState {
  session: AgentSession;
  queue: SignalQueue;
  cwd: string;
  startedAt: number;
  startSha: string | null;
  sessionFile: string; // absolute path — the resume handle stored as nativeSessionId
  superseded: boolean;
  repo: RepoSpec | null; // clone-on-demand repo, if any
  repoHome: string; // shared clone dir (cwd is the per-task worktree under it); == cwd for non-clone tasks
  // Live per-repo token the bash spawn hook injects into the agent's shell (git/gh auth). Held in a
  // ref so the refresh timer can update it in place without re-wiring the hook. null = no creds.
  tokenRef: { current: string | null };
  credsTimer: ReturnType<typeof setInterval> | null;
}

// Poll the token provider often; it serves the cached token until ~5min before expiry and re-mints
// past that, so frequent polling keeps the injected token fresh for long tasks at near-zero cost
// (most ticks are cache hits, no API call).
const TOKEN_REFRESH_MS = 4 * 60_000;

/**
 * Pi coding-agent runner adapter — same RunnerAdapter contract as ClaudeCodeRunnerAdapter, so a
 * runner daemon selects it by RUNNER_KIND. Runs on OpenRouter (per-token billing), not a Claude
 * subscription. Sessions persist as files under agentDir; the file path is the resume handle.
 */
export class PiRunnerAdapter implements RunnerAdapter {
  private readonly progressDebounceMs: number;
  private readonly now: () => number;
  private readonly tasks = new Map<string, PiTaskState>();

  constructor(private readonly options: PiRunnerOptions) {
    this.progressDebounceMs = options.progressDebounceMs ?? 1500;
    this.now = options.now ?? Date.now;
    this.startWorktreeGc();
  }

  // Periodically reclaim task worktrees whose PR has merged or that have gone idle past the TTL.
  // Active tasks are always skipped. No-op unless clone-on-demand + a workspace root are configured.
  private startWorktreeGc(): void {
    const { repoOps, workspaceRoot } = this.options;
    if (!repoOps || !workspaceRoot) return;
    const ttlMs = this.options.worktreeTtlMs ?? 24 * 3600_000;
    const run = () =>
      void pruneWorktrees({ workspaceRoot, ttlMs, activeTaskIds: new Set(this.tasks.keys()), deps: repoOps, now: this.now })
        .then((removed) => {
          if (removed.length) log.info({ count: removed.length }, "pruned task worktrees");
        })
        .catch((err) => log.warn({ err }, "worktree GC sweep failed"));
    const timer = setInterval(run, this.options.gcIntervalMs ?? 3600_000);
    timer.unref?.();
  }

  async start(input: { taskId: string; cwd: string; prompt: string; repo?: RepoSpec | null }): Promise<{ nativeSessionId: string }> {
    const repo = input.repo ?? null;
    const repoHome = input.cwd;
    let cwd = input.cwd;
    if (repo && this.options.repoOps) {
      await cloneIfAbsent(repoHome, repo, this.options.repoOps);
      cwd = await ensureWorktree(repoHome, input.taskId, this.options.repoOps); // per-task isolation
    }
    const tokenRef: { current: string | null } = { current: null };
    const credsTimer = await this.provisionCreds(repoHome, repo, tokenRef);
    const { session, sessionFile } = await this.createSession(cwd, null, tokenRef, repoHome);
    const startSha = await this.readHeadSha(cwd);
    const state: PiTaskState = {
      session,
      queue: new SignalQueue(),
      cwd,
      startedAt: this.now(),
      startSha,
      sessionFile,
      superseded: false,
      repo,
      repoHome,
      tokenRef,
      credsTimer,
    };
    this.tasks.set(input.taskId, state);
    this.wireAndPrompt(input.taskId, state, input.prompt);
    return { nativeSessionId: sessionFile };
  }

  // Mint the per-repo token, keep it fresh, and (re)write the git askpass helper + pre-push guard so
  // the agent's own git/gh authenticate. Returns the refresh timer (or null when there are no creds).
  private async provisionCreds(
    repoHome: string,
    repo: RepoSpec | null,
    tokenRef: { current: string | null },
  ): Promise<ReturnType<typeof setInterval> | null> {
    const ops = this.options.repoOps;
    if (!repo || !ops) return null;
    configureForAgent(repoHome); // askpass + pre-push in the shared clone (worktrees share its .git)
    tokenRef.current = (await ops.provider.tokenFor(repo)).token;
    const timer = setInterval(() => {
      void ops.provider
        .tokenFor(repo)
        .then((t) => {
          tokenRef.current = t.token;
        })
        .catch((err) => log.warn({ err, repo }, "failed to refresh runner git token"));
    }, TOKEN_REFRESH_MS);
    timer.unref?.();
    return timer;
  }

  async resume(input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string }): Promise<void> {
    const existing = this.tasks.get(input.taskId);
    if (existing) {
      existing.superseded = true;
      await existing.session.abort().catch(() => {});
      existing.queue.close();
    }
    // The registry stores cwd = the shared clone dir (repoHome); the runner re-derives the task's
    // worktree from the taskId, so resume lands in the same isolated worktree.
    const repoHome = existing?.repoHome ?? (input.cwd || existing?.cwd);
    if (!repoHome) throw new Error(`no working directory recorded for task ${input.taskId} — re-dispatch instead of resuming`);
    if (existing?.credsTimer) clearInterval(existing.credsTimer);
    // resume() carries no repo spec; recover it from the shared clone's origin so a resumed
    // clone-on-demand task keeps working git/gh creds. Only meaningful when repoOps is configured.
    const repo = existing?.repo ?? (this.options.repoOps ? await this.repoFromRemote(repoHome) : null);
    let cwd = repoHome;
    if (repo && this.options.repoOps) cwd = await ensureWorktree(repoHome, input.taskId, this.options.repoOps);
    const tokenRef: { current: string | null } = { current: null };
    const credsTimer = await this.provisionCreds(repoHome, repo, tokenRef);
    // nativeSessionId is the persisted session file path; open() resumes that exact session.
    const { session, sessionFile } = await this.createSession(cwd, input.nativeSessionId, tokenRef, repoHome);
    const startSha = existing?.startSha ?? (await this.readHeadSha(cwd));
    const state: PiTaskState = { session, queue: new SignalQueue(), cwd, startedAt: this.now(), startSha, sessionFile, superseded: false, repo, repoHome, tokenRef, credsTimer };
    this.tasks.set(input.taskId, state);
    this.wireAndPrompt(input.taskId, state, input.prompt);
  }

  async interrupt(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.credsTimer) clearInterval(task.credsTimer);
    await task.session.abort().catch(() => {});
    task.queue.close();
    task.session.dispose();
    this.tasks.delete(taskId);
  }

  async stream(taskId: string, onEvent: (e: RunnerEvent) => void): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const reducer = new RunnerEventReducer(taskId, this.progressDebounceMs, this.now);
    onEvent(reducer.start());

    while (true) {
      const { value: sig, done } = await task.queue.next();
      if (done) {
        // A superseded task was intentionally aborted by resume(); the new session reports status.
        if (!task.superseded) for (const event of reducer.finalize()) onEvent(event);
        break;
      }
      let terminal = false;
      for (const event of reducer.onSignal(sig)) {
        if (event.kind === "handback") {
          const gitMeta = await this.computeGitMeta(task.cwd, task.startSha);
          const meta: HandbackMeta = { ...event.meta, ...gitMeta, durationMs: event.meta?.durationMs ?? this.now() - task.startedAt };
          onEvent({ ...event, meta });
        } else {
          onEvent(event);
        }
        if (event.kind === "status" && (event.status === "idle" || event.status === "done" || event.status === "failed")) terminal = true;
      }
      if (terminal) break;
    }
    if (this.tasks.get(taskId) === task) {
      if (task.credsTimer) clearInterval(task.credsTimer);
      this.tasks.delete(taskId);
    }
  }

  // Subscribes the session's events into the task's queue and fires the prompt. On resolution,
  // synthesizes the terminal "result" signal (Pi has no single run-finished event) and closes the
  // queue so stream() drains to idle. A thrown prompt becomes a failed result.
  private wireAndPrompt(taskId: string, state: PiTaskState, prompt: string): void {
    const acc: TurnAccumulator = { finalText: "", tokens: undefined };
    state.session.subscribe((event: AgentSessionEvent) => {
      for (const sig of piEventToSignals(event, acc)) state.queue.push(sig);
    });
    void state.session
      .prompt(prompt)
      .then(() => {
        state.queue.push({ type: "result", success: true, resultText: acc.finalText, tokens: acc.tokens });
      })
      .catch((err) => {
        log.error({ err, taskId }, "pi session prompt failed");
        state.queue.push({ type: "result", success: false, errorMessage: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (!state.superseded) state.queue.close();
      });
  }

  private async createSession(
    cwd: string,
    resumeSessionFile: string | null,
    tokenRef: { current: string | null },
    repoHome: string,
  ): Promise<{ session: AgentSession; sessionFile: string }> {
    const { createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createBashToolDefinition } =
      await import("@earendil-works/pi-coding-agent");
    // A fresh runner (e.g. a new container volume) has no agentDir yet; ModelRuntime.create expects
    // the auth/models files to exist. The provider is registered inline below, so empty files are
    // enough — create them if absent rather than requiring a provisioning step.
    mkdirSync(this.options.agentDir, { recursive: true });
    const authPath = join(this.options.agentDir, "auth.json");
    const modelsPath = join(this.options.agentDir, "models.json");
    if (!existsSync(authPath)) writeFileSync(authPath, "{}");
    if (!existsSync(modelsPath)) writeFileSync(modelsPath, "{}");
    const modelRuntime = await ModelRuntime.create({ authPath, modelsPath });
    const contextWindow = await resolveContextWindow(this.options.model, this.options.fallbackContextWindow ?? 800_000);
    const maxTokens = Math.min(this.options.maxOutputTokens ?? 65_536, contextWindow);
    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "sushii runner OpenRouter",
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      api: "openai-completions",
      models: [
        {
          id: this.options.model,
          name: this.options.model,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
          samplingParams: { provider: { data_collection: "deny" } },
          compat: { sendSessionAffinityHeaders: true },
        },
      ],
    });
    const model = modelRuntime.getModel(PROVIDER_ID, this.options.model);
    if (!model) throw new Error(`pi runner model ${PROVIDER_ID}/${this.options.model} failed to register`);

    const sessionDir = `${this.options.agentDir}/sessions`;
    const sessionManager = resumeSessionFile
      ? SessionManager.open(resumeSessionFile, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir);
    const loader = new DefaultResourceLoader({ cwd, agentDir: this.options.agentDir, systemPromptOverride: () => RUNNER_SYSTEM_PROMPT });
    await loader.reload();

    // Custom bash tool whose every spawn gets the per-repo git/gh credentials injected into its env
    // (fresh token via tokenRef). This is how the agent's own `git push` / `gh pr create` authenticate
    // without the runner pushing for it, and without the App key ever reaching the agent.
    const bashTool = createBashToolDefinition(cwd, {
      spawnHook: (context) => {
        const token = tokenRef.current;
        if (token) Object.assign(context.env, agentGitEnv(repoHome, token));
        return context;
      },
    });

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      // "bash" MUST stay in this allowlist: Pi filters customTools by the same allowlist
      // (isAllowedTool), then a same-named custom tool overrides the built-in — so our credential-
      // injecting bash only wins if "bash" is allowed. Drop it and the agent gets no shell at all.
      tools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
      // Cast: the factory returns a bash-specialized ToolDefinition; customTools wants the generic
      // one (TS invariance on the render generics). The runtime object is a valid tool def.
      customTools: [bashTool as unknown as ToolDefinition],
      excludeTools: ["ask_question"],
      sessionManager,
    });

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("pi session has no persisted file — cannot resume later");
    return { session, sessionFile };
  }

  private async readHeadSha(cwd: string): Promise<string | null> {
    try {
      return (await simpleGit(cwd).revparse(["HEAD"])).trim();
    } catch (err) {
      log.warn({ err, cwd }, "failed to read HEAD sha");
      return null;
    }
  }

  // Owner/repo from the checkout's origin remote — used to recover a repo spec on resume. Handles
  // both https and ssh remote forms.
  private async repoFromRemote(cwd: string): Promise<RepoSpec | null> {
    try {
      const url = (await simpleGit(cwd).remote(["get-url", "origin"]))?.trim();
      const m = url?.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
      return m ? { owner: m[1], repo: m[2] } : null;
    } catch {
      return null;
    }
  }

  private async computeGitMeta(cwd: string, startSha: string | null): Promise<Pick<HandbackMeta, "filesChanged" | "commits">> {
    try {
      const git = simpleGit(cwd);
      const status = await git.status();
      let commits = 0;
      if (startSha) {
        const gitLog = await git.log({ from: startSha, to: "HEAD" });
        commits = gitLog.total;
      }
      return { filesChanged: status.files.length, commits };
    } catch (err) {
      log.warn({ err, cwd }, "failed to compute git handback metadata");
      return {};
    }
  }
}
