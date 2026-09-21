import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HandbackMeta, RepoSpec, RunnerAdapter, RunnerEvent } from "../contracts.ts";
import { getLogger } from "../../logger.ts";
import { RunnerEventReducer, type StreamLineEvent } from "./claudeCodeRunner.ts";
import { cloneIfAbsent, pushWorkAndOpenPr, type RepoOpsDeps } from "./repoOps.ts";

const log = getLogger("orchestration.runner.pi");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODEL_METADATA_TIMEOUT_MS = 5000;
const PROVIDER_ID = "sushii-runner-openrouter";

// Generic coding-runner system prompt. The trailing summary instruction is what makes the handback
// informative — without it a model that does its work purely via tools stops with no final text, so
// the handback recap comes back empty ("Stopped."). Kept minimal + agent-agnostic (no wiki/Discord).
const RUNNER_SYSTEM_PROMPT = `You are an autonomous coding agent working in a git repository. Carry out the requested task directly using your tools (read, edit, write, bash, etc.). Commit your work with git when the task implies it. Do NOT push, and do NOT open a pull request or use the gh CLI — pushing the branch and opening the PR is handled for you automatically after you finish, so just leave your commits on the current branch. When you finish, end your turn with a concise one- or two-sentence summary of exactly what you changed — which files, and the commit — or state plainly that nothing needed changing.`;

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
    return [{ type: "tool_use", name: event.toolName }];
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
  repo: RepoSpec | null; // set → runner pushes a branch + opens a PR at handback (clone-on-demand)
}

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
  }

  async start(input: { taskId: string; cwd: string; prompt: string; repo?: RepoSpec | null }): Promise<{ nativeSessionId: string }> {
    const repo = input.repo ?? null;
    if (repo && this.options.repoOps) await cloneIfAbsent(input.cwd, repo, this.options.repoOps);
    const { session, sessionFile } = await this.createSession(input.cwd, null);
    const startSha = await this.readHeadSha(input.cwd);
    const state: PiTaskState = {
      session,
      queue: new SignalQueue(),
      cwd: input.cwd,
      startedAt: this.now(),
      startSha,
      sessionFile,
      superseded: false,
      repo,
    };
    this.tasks.set(input.taskId, state);
    this.wireAndPrompt(input.taskId, state, input.prompt);
    return { nativeSessionId: sessionFile };
  }

  async resume(input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string }): Promise<void> {
    const existing = this.tasks.get(input.taskId);
    if (existing) {
      existing.superseded = true;
      await existing.session.abort().catch(() => {});
      existing.queue.close();
    }
    const cwd = input.cwd || existing?.cwd;
    if (!cwd) throw new Error(`no working directory recorded for task ${input.taskId} — re-dispatch instead of resuming`);
    // nativeSessionId is the persisted session file path; open() resumes that exact session.
    const { session, sessionFile } = await this.createSession(cwd, input.nativeSessionId);
    const startSha = existing?.startSha ?? (await this.readHeadSha(cwd));
    // resume() carries no repo spec; recover it from the checkout's origin so a resumed
    // clone-on-demand task still pushes at handback. Only meaningful when repoOps is configured.
    const repo = existing?.repo ?? (this.options.repoOps ? await this.repoFromRemote(cwd) : null);
    const state: PiTaskState = { session, queue: new SignalQueue(), cwd, startedAt: this.now(), startSha, sessionFile, superseded: false, repo };
    this.tasks.set(input.taskId, state);
    this.wireAndPrompt(input.taskId, state, input.prompt);
  }

  async interrupt(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
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
          const pushMeta = await this.pushIfCloneOnDemand(taskId, task, event.summary);
          const meta: HandbackMeta = { ...event.meta, ...gitMeta, ...pushMeta, durationMs: event.meta?.durationMs ?? this.now() - task.startedAt };
          onEvent({ ...event, meta });
        } else {
          onEvent(event);
        }
        if (event.kind === "status" && (event.status === "idle" || event.status === "done" || event.status === "failed")) terminal = true;
      }
      if (terminal) break;
    }
    if (this.tasks.get(taskId) === task) this.tasks.delete(taskId);
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

  private async createSession(cwd: string, resumeSessionFile: string | null): Promise<{ session: AgentSession; sessionFile: string }> {
    const { createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader } = await import(
      "@earendil-works/pi-coding-agent"
    );
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

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      // A generic coding runner needs the full toolset incl. bash so the agent can run tests/git
      // itself; handback metadata is derived from the git diff afterward (kind-agnostic), not a
      // Pi-specific commit tool.
      tools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
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

  // Runner-side push at handback: the agent never holds a git credential and never pushes; this is
  // the only push path, and it targets a task branch, not the default. A push/PR failure must not
  // sink the handback — the summary still goes back, minus the branch/PR fields.
  private async pushIfCloneOnDemand(
    taskId: string,
    task: PiTaskState,
    summary: string,
  ): Promise<Pick<HandbackMeta, "branch" | "prUrl">> {
    if (!task.repo || !this.options.repoOps) return {};
    try {
      const result = await pushWorkAndOpenPr(task.cwd, task.repo, { taskId, summary, startSha: task.startSha }, this.options.repoOps);
      return result ? { branch: result.branch, prUrl: result.prUrl } : {};
    } catch (err) {
      log.error({ err, taskId, cwd: task.cwd }, "runner-side push/PR failed; handback continues without it");
      return {};
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
