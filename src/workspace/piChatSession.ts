import type { BrowserManager, BrowserBinding } from "./browser.ts";
import { relative } from "node:path";
import { threadAwareness, threadContextTools } from "./threadContext.ts";
import { createGitHubPushTool, GITHUB_PUSH_TOOL } from "./githubPush.ts";
import { CONNECTOR_TOOLS, type ConnectorManager } from "./connectors.ts";
import { assertExactTools, createAgentBashTool, createOpenRouterModel } from "../agentRuntime/piShared.ts";
import type { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../logger.ts";
import type { ChatSession, ChatSessionFactory } from "./personalSession.ts";
import { DEFAULT_JUDGE_CHATGPT_MODEL, DEFAULT_JUDGE_MODEL, OPENROUTER_IDLE_ROTATE_MIN, economyOf, taskRulesOf, type WorkspaceConfig } from "./config.ts";
import {
  anchoredInstruction,
  continueWithInstruction,
  createAnchoredCompactionExtension,
  createHygieneExtension,
  reserveTokensFor,
  type ContinuationResult,
  type HygieneState,
} from "./contextEconomy.ts";
import type { ModelChoice } from "./modelChoice.ts";
import { createAutoModeExtension, judgeCompletion, judgeForBackend, registerJudgeModel } from "./autoMode.ts";
import { homeAgentsFilesOverride } from "./home.ts";
import { createSecretGuardExtension } from "./secretGuard.ts";
import { createMemoryGuardExtension } from "./memoryGuard.ts";
import { createLoopGuardExtension, type LoopGuardState } from "./loopGuard.ts";
import { createVerifyGateExtension } from "./verifyGate.ts";
import { createCompactionHandoffExtension } from "./memoryFlush.ts";
import { RunLog, type RunRecorder } from "./runLog.ts";
import { observeRuns, type RunObserver } from "./runObserver.ts";
import { chatSessionDir } from "./sessionPaths.ts";
import { SEND_FILE_TOOL, createSendFileTool } from "./sendFile.ts";
import { KNOWN_PROXIED_TOOLS, type ToolStubs } from "./toolStubs.ts";
import type { SubagentHost } from "./subagents/host.ts";
import type { GitHubCredentials } from "./githubCredentials.ts";
import {
  BackendSelector,
  CHATGPT_PROVIDER,
  chatGptSignedIn,
  createModelFallbackExtension,
  restoreChatGptThinking,
  selectInitialModel,
} from "./chatgptFallback.ts";

type Settings = Parameters<SettingsManager["applyOverrides"]>[0];

const log = getLogger("workspace.model");
const economyLog = getLogger("workspace.context");
const guardLog = getLogger("workspace.guard");
const memoryLog = getLogger("workspace.memory");
const autoModeLog = getLogger("workspace.automode");

const PROVIDER_ID = "sushii-workspace-openrouter";
const WORKSPACE_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "bash", SEND_FILE_TOOL];

/** Pi's bash under the agent env allowlist, minus PI_* (PI_CODING_AGENT_DIR and PI_SESSION_FILE point at the agent dir).
 *  `WS_RUN_ID` is the run in progress at spawn time, so `ws-runs` can default to it. */
export function createWorkspaceBashTool(cwd: string, currentRunId: () => string | null = () => null, github?: Pick<GitHubCredentials, "envFor">, browser?: BrowserBinding) {
  const extraEnv = (): Record<string, string> => {
    const runId = currentRunId();
    return { ...(runId ? { WS_RUN_ID: runId } : {}), ...browser?.env() };
  };
  const prepareEnv = github ? (command: string, dir: string) => github.envFor(command, dir) : undefined;
  return createAgentBashTool(cwd, extraEnv, { dropPrefixes: ["PI_"], exposeSessionEnvironment: false, prepareEnv });
}

const runObservers = new WeakMap<object, RunObserver>();

/** The runId of `session`'s run in progress (a subagent's parentRunId); null between runs. */
export function currentRunId(session: ChatSession): string | null {
  return runObservers.get(session)?.currentRunId() ?? null;
}

/** In-memory settings overrides per live session, re-applied after a reload drops them. */
const sessionOverrides = new WeakMap<object, { session: AgentSession; overrides: Settings; context: () => readonly { path: string; content: string }[] }>();

/** Re-reads the home context files (and Pi's settings/resources) into `session`'s system prompt. */
export async function reloadContext(session: ChatSession): Promise<void> {
  const entry = sessionOverrides.get(session);
  if (!entry) throw new Error("reloadContext: session was not built by the pi chat session factory");
  // reload() re-reads settings first, discarding applyOverrides(), so re-apply even if a later step throws.
  try {
    await entry.session.reload();
  } finally {
    entry.session.settingsManager.applyOverrides(entry.overrides);
  }
}

/** Files actually loaded in this session, including the rendered task context. */
export function loadedContextFiles(session: ChatSession): readonly { path: string; content: string }[] {
  return sessionOverrides.get(session)?.context() ?? [];
}

/** Tokens past which Pi auto-compacts `session` on its current model (shouldCompact in Pi's compaction.js). */
export function compactionTrigger(session: ChatSession): number | null {
  const entry = sessionOverrides.get(session);
  const model = entry?.session.model;
  if (!entry || !model || !(model.contextWindow > 0)) return null;
  const settings = entry.session.settingsManager.getCompactionSettings(model);
  return settings.enabled ? model.contextWindow - settings.reserveTokens : null;
}

function piSession(session: ChatSession, what: string): AgentSession {
  const entry = sessionOverrides.get(session);
  if (!entry) throw new Error(`${what}: session was not built by the pi chat session factory`);
  return entry.session;
}

/** The latest compaction summary on the session's branch, the base a recap merges into. */
function latestSummary(session: AgentSession): string | undefined {
  const branch = session.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "compaction") return e.summary;
  }
  return undefined;
}

/** A recap of `session` in the anchored-summary layout, generated as a cached continuation of its context. */
export async function recapSession(session: ChatSession, signal?: AbortSignal): Promise<ContinuationResult | null> {
  const s = piSession(session, "recapSession");
  return continueWithInstruction(s, anchoredInstruction("recap", latestSummary(s)), signal);
}

/** Compacts `session` now (our anchored summary via session_before_compact); tokens before and after. */
export async function compactSession(session: ChatSession): Promise<{ tokensBefore: number; tokensAfter: number | null }> {
  const s = piSession(session, "compactSession");
  const result = await s.compact();
  return { tokensBefore: result.tokensBefore, tokensAfter: result.estimatedTokensAfter ?? null };
}

/** How long `session` must sit idle before it rotates: OpenRouter's sticky routing lapses sooner than ChatGPT's cache. */
export function idleRotateMs(session: ChatSession, config: Pick<WorkspaceConfig, "economy">): number {
  const minutes = economyOf(config).idleRotateMin;
  const onChatGpt = sessionOverrides.get(session)?.session.model?.provider === CHATGPT_PROVIDER;
  return (onChatGpt ? minutes : Math.min(minutes, OPENROUTER_IDLE_ROTATE_MIN)) * 60_000;
}

/** The session's current model label, as the footer shows it. */
export function sessionModelLabel(session: ChatSession): string | null {
  const model = sessionOverrides.get(session)?.session.model;
  return model ? (model.provider === CHATGPT_PROVIDER ? `chatgpt/${model.id}` : model.id) : null;
}

function chatgptJudgeModel(runtime: Pick<ModelRuntime, "getModel">, config: WorkspaceConfig) {
  const id = config.judgeChatgptModel ?? DEFAULT_JUDGE_CHATGPT_MODEL;
  const model = runtime.getModel(CHATGPT_PROVIDER, id);
  if (!model) autoModeLog.warn({ model: id }, "ChatGPT judge model not in Pi's openai catalog; the judge uses OpenRouter");
  return model;
}

/** Builds real Pi chat sessions: cwd = HOME, default context-file discovery plus the home context
 *  files, settings.json and auth.json under agentDir. ChatGPT sign-in is the primary model when
 *  configured and signed in; OpenRouter is the fallback. */
export function createPiChatSessionFactory(
  config: WorkspaceConfig,
  opts: {
    runs?: RunRecorder;
    toolStubs?: ToolStubs;
    selector?: BackendSelector;
    subagents?: SubagentHost;
    choice?: ModelChoice;
    github?: GitHubCredentials;
    connectors?: ConnectorManager;
    browsers?: BrowserManager;
    /** The Main turn in progress, stamped on each main run so the bot can join its replies and files. */
    mainTurnId?: () => string | undefined;
    sessionDir?: string;
    agentName?: string;
    origin?: import("../orchestration/contracts.ts").ChatOrigin;
    parentTurn?: () => import("./subagents/turnTracker.ts").ParentTurn | null;
  } = {},
): ChatSessionFactory {
  const runs = opts.runs ?? new RunLog(config.stateDir);
  // The process-wide selector in production; a fallback instance only for tests that build a factory alone.
  const selector = opts.selector ?? new BackendSelector({ primaryEnabled: config.provider === "chatgpt" });

  return async ({ sessionFile, ui, checkpoint }) => {
    const topicTools = opts.origin?.conversationId && opts.origin.conversationId !== "main" ? [] : threadContextTools({ principalId: config.principalId, stateDir: config.stateDir, home: config.home, tz: config.tz, agentDirs: [config.agentDir] });
    const topicToolNames = topicTools.map((t) => t.name);
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const economy = economyOf(config);
    const {
      modelRuntime,
      model: openrouterModel,
      maxTokens,
      models: openrouterModels,
      register: registerOpenRouter,
    } = await createOpenRouterModel({
      agentDir: config.agentDir,
      providerId: PROVIDER_ID,
      providerName: "sushii workspace OpenRouter",
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      extraModels: opts.choice?.openrouterIds() ?? [],
    });
    // Picks made from here on register in this session before they apply; one made while it was being
    // created is caught by the register right after subscribing.
    let syncOverrides: (() => void) | null = null;
    const unsubscribeChoice = opts.choice?.onPrepare(async (ids) => {
      await registerOpenRouter(ids);
      syncOverrides?.();
    });
    if (opts.choice) await registerOpenRouter(opts.choice.openrouterIds());
    const openrouterJudge = config.autoMode
      ? registerJudgeModel(modelRuntime, { model: config.judgeModel ?? DEFAULT_JUDGE_MODEL, apiKey: config.apiKey, baseUrl: config.baseUrl })
      : null;
    const chatgptJudge = openrouterJudge && config.provider === "chatgpt" ? chatgptJudgeModel(modelRuntime, config) : undefined;
    const chatgptModel = config.provider === "chatgpt" ? modelRuntime.getModel(CHATGPT_PROVIDER, config.chatgptModel) : undefined;
    // Read per turn: `!model` rewrites the shared config between turns.
    const currentPrimary = () => (config.provider === "chatgpt" ? modelRuntime.getModel(CHATGPT_PROVIDER, config.chatgptModel) : undefined);
    // A choice registers its model before it changes the config, so a miss here means registration failed:
    // stay on the OpenRouter model in use rather than jump to the one this session started on.
    const currentFallback = () => {
      const picked = openrouterModels.get(config.model);
      if (picked) return picked;
      const inUse = sessionRef.current?.model;
      log.warn({ model: config.model }, "picked OpenRouter model isn't registered; keeping the current one");
      return inUse?.provider === PROVIDER_ID ? (inUse as typeof openrouterModel) : openrouterModel;
    };
    const model = await selectInitialModel({
      config,
      runtime: modelRuntime,
      selector,
      primary: chatgptModel,
      fallback: openrouterModel,
      log,
    });

    const cwd = config.home;
    const sessionDir = opts.sessionDir ?? chatSessionDir(config.agentDir);
    const sessionManager = sessionFile ? SessionManager.open(sessionFile, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);

    // The extension's handlers only run once createAgentSession has returned and set this.
    const sessionRef: { current: AgentSession | null } = { current: null };
    const fallbackExtension = createModelFallbackExtension({
      selector,
      primary: currentPrimary,
      fallback: currentFallback,
      signedIn: () => chatGptSignedIn(modelRuntime),
      setModel: async (m) => {
        const session = sessionRef.current;
        if (!session) throw new Error("pi chat session not ready");
        await session.setModel(m);
        if (m.provider === CHATGPT_PROVIDER) restoreChatGptThinking(session);
      },
      log,
    });
    const stubs = opts.toolStubs?.binding({ agentId: "main", agentName: opts.agentName ?? "main", ...(opts.origin ? { origin: opts.origin } : {}) });
    const observerRef: { current: RunObserver | null } = { current: null };
    const browser = opts.browsers?.bind(opts.origin?.conversationId ?? "main", () => observerRef.current?.currentRunId() ?? null);
    const browserTools = browser ? ["browser"] : [];
    const pushTools = opts.github ? [GITHUB_PUSH_TOOL] : [];
    const connectorTools = opts.connectors ? CONNECTOR_TOOLS : [];
    const delegate = opts.subagents?.offersDelegate(0) ? ["delegate"] : [];
    const loopState: LoopGuardState = { nudged: false };
    const hygieneState: HygieneState = { armed: true };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: config.agentDir,
      agentsFilesOverride: homeAgentsFilesOverride(cwd, { tasks: taskRulesOf(config) }),
      // Only the factories below: the agent can write ~/.pi and <cwd>/.pi, so discovered extensions would run its code in-process.
      noExtensions: true,
      extensionFactories: [
        ...(checkpoint ? [{ name: "sushii-durable-input", factory: createInputCheckpointExtension(checkpoint) }] : []),
        ...(!opts.origin || opts.origin.conversationId === "main" ? [{ name: "sushii-thread-awareness", factory: threadAwareness(config.stateDir) }] : []),
        // First: tool_call stops at the first block, so a guard ahead of it would hide repeats from it.
        { name: "sushii-loop-guard", factory: createLoopGuardExtension({ log, state: loopState }) },
        { name: "sushii-secret-guard", factory: createSecretGuardExtension({ agentDir: config.agentDir, cwd, home: config.home, stateDir: config.stateDir, log: guardLog }) },
        { name: "sushii-model-fallback", factory: fallbackExtension },
        ...(opts.connectors ? [{ name: "sushii-connectors", factory: opts.connectors.extensionFor(() => observerRef.current?.currentRunId() ?? null) }] : []),
        ...(stubs ? [{ name: "sushii-tool-stubs", factory: stubs.factory }] : []),
        { name: "sushii-memory-guard", factory: createMemoryGuardExtension({ home: config.home, cwd, log: memoryLog }) },
        { name: "sushii-verify-gate", factory: createVerifyGateExtension({ home: config.home, cwd, log, loopNudged: () => loopState.nudged }) },
        // After the deterministic guards, so their blocks cost no judge call or owner prompt.
        ...(openrouterJudge
          ? [
              {
                name: "sushii-auto-mode",
                factory: createAutoModeExtension({
                  judge: judgeForBackend({ selector, runtime: modelRuntime, chatgpt: chatgptJudge, openrouter: openrouterJudge }),
                  complete: judgeCompletion(modelRuntime, { selector, openrouter: openrouterJudge, log: autoModeLog }),
                  agentDir: config.agentDir,
                  currentRunId: () => observerRef.current?.currentRunId() ?? null,
                  log: autoModeLog,
                }),
              },
            ]
          : []),
        // After every blocking guard (a blocked call never releases its write lease), and before the
        // compaction handoff so main's memory lease is held when the handoff writes.
        ...(opts.subagents && delegate.length
          ? [{ name: "sushii-delegate", factory: opts.subagents.extension({ depth: 0, ...(opts.parentTurn ? { currentTurn: opts.parentTurn } : {}), currentRunId: () => observerRef.current?.currentRunId() ?? null }) }]
          : []),
        { name: "sushii-compaction-handoff", factory: createCompactionHandoffExtension({ home: config.home, log: memoryLog }) },
        { name: "sushii-hygiene", factory: createHygieneExtension({ thresholdTokens: economy.hygieneTokens, state: hygieneState, log: economyLog }) },
        // After the handoff: the last session_before_compact result wins.
        {
          name: "sushii-anchored-compaction",
          factory: createAnchoredCompactionExtension({
            summarize: ({ previous, signal }) => {
              const session = sessionRef.current;
              if (!session) throw new Error("pi chat session not ready");
              return continueWithInstruction(session, anchoredInstruction("compaction", previous), signal);
            },
            log: economyLog,
          }),
        },
      ],
    });
    await loader.reload();

    // In-memory only (session.reload() drops it): a 16k default reserve overflows on a maxTokens-sized turn.
    const settingsManager = SettingsManager.create(cwd, config.agentDir);
    // Every model `!model` can pick, so the trigger holds across a switch.
    const modelOverrides: Record<string, { reserveTokens: number }> = {};
    const chatgptIds = new Set([config.chatgptModel, ...(config.models ?? []).filter((e) => e.backend === "chatgpt").map((e) => e.id)]);
    const known = [...openrouterModels.values(), ...[...chatgptIds].flatMap((id) => modelRuntime.getModel(CHATGPT_PROVIDER, id) ?? [])];
    for (const m of known) modelOverrides[`${m.provider}/${m.id}`] = { reserveTokens: reserveTokensFor(m.contextWindow, economy.compactTokens) };
    const overrides: Settings = {
      compaction: {
        enabled: true,
        reserveTokens: reserveTokensFor(openrouterModel.contextWindow, economy.compactTokens),
        keepRecentTokens: economy.keepRecentTokens,
        modelOverrides,
      },
    };
    settingsManager.applyOverrides(overrides);
    // A model registered after the session started gets its compaction trigger too.
    syncOverrides = () => {
      for (const m of openrouterModels.values()) {
        modelOverrides[`${m.provider}/${m.id}`] = { reserveTokens: reserveTokensFor(m.contextWindow, economy.compactTokens) };
      }
      settingsManager.applyOverrides(overrides);
    };
    syncOverrides();
    // Warm requests would spend the ChatGPT subscription. Pi reads the mode only from the shared global
    // settings.json, out of applyOverrides' reach; an instance override also survives session.reload().
    settingsManager.getCacheWarmingMode = () => "off";

    const rawBashTool = await createWorkspaceBashTool(cwd, () => observerRef.current?.currentRunId() ?? null, opts.github, browser);
    const bashTool = browser ? browser.wrapBash(rawBashTool) : rawBashTool;
    const sendFileTool = createSendFileTool({ cwd, home: config.home, agentDir: config.agentDir, stateDir: config.stateDir }, () => sessionRef.current);
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      ({ session } = await createAgentSession({
        cwd,
        agentDir: config.agentDir,
        model,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        // Pi filters customTools by this allowlist: "bash" here is the env-allowlisted override.
        // Pi freezes this at creation, so it names every tool the bot may offer later, registered or not.
        tools: [...WORKSPACE_TOOLS, ...browserTools, ...topicToolNames, ...pushTools, ...connectorTools, ...delegate, ...(stubs ? KNOWN_PROXIED_TOOLS : [])],
        customTools: [bashTool, sendFileTool, ...(browser ? [browser.tool()] : []), ...topicTools, ...(opts.github ? [createGitHubPushTool(cwd, opts.github)] : [])],
        excludeTools: ["ask_question"],
        sessionManager,
      }));
      sessionRef.current = session;
      assertExactTools(session, [...WORKSPACE_TOOLS, ...browserTools, ...topicToolNames, ...pushTools, ...connectorTools, ...delegate, ...(stubs?.registeredNames() ?? [])], "workspace", [...WORKSPACE_TOOLS, ...browserTools, ...topicToolNames, ...pushTools, ...connectorTools, ...delegate, ...(stubs?.offered() ?? [])]);
      stubs?.assertOwned(session, "workspace");
      // Pi keeps this binding across session.reload(), so each new session binds once.
      if (ui) await session.bindExtensions({ uiContext: ui, mode: "rpc" });
    } catch (err) {
      sessionRef.current?.dispose();
      stubs?.release();
      unsubscribeChoice?.();
      throw err;
    }
    const unsubscribeBrowser = browser ? session.subscribe((event) => {
      if (event.type === "agent_settled") void browser.finish().catch((err) => log.warn({ err }, "browser cleanup failed"));
    }) : undefined;
    const browserHeartbeat = browser ? setInterval(() => { if (session.isStreaming) browser.touch(); }, 60_000) : undefined;
    browserHeartbeat?.unref();
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      try {
        return dispose();
      } finally {
        unsubscribeBrowser?.();
        clearInterval(browserHeartbeat);
        void browser?.finish().catch((err) => log.warn({ err }, "browser cleanup failed"));
        stubs?.release();
        unsubscribeChoice?.();
      }
    };
    if (model.provider === CHATGPT_PROVIDER) restoreChatGptThinking(session);

    const file = sessionManager.getSessionFile();
    if (!file) throw new Error("pi chat session has no persisted file");
    sessionOverrides.set(session, { session, overrides, context: () => loader.getAgentsFiles().agentsFiles.map(f => ({ ...f, path: relative(config.home, f.path) })).filter(f => f.path && !f.path.startsWith("..") && !f.path.startsWith("/")) });
    const observer = observeRuns(session, { recorder: runs, sessionFile: file, agentName: opts.agentName ?? "main", defaultModel: config.model, turnId: opts.mainTurnId, conversationId: opts.origin?.conversationId ?? "main" });
    observerRef.current = observer;
    runObservers.set(session, observer);
    return { session, sessionFile: file, currentRunId: () => observer.currentRunId() };
  };
}

/** Pi event observers queue the consumed-input commit; await it before executing any tools. */
export function createInputCheckpointExtension(checkpoint: () => Promise<void>): import("@earendil-works/pi-coding-agent").ExtensionFactory {
  return (pi) => {
    pi.on("context", async () => { await checkpoint(); });
    // Context-hook errors are reported by Pi and do not stop generation. Tool guards fail closed.
    pi.on("tool_call", async () => {
      try {
        await checkpoint();
        return undefined;
      } catch {
        return { block: true, reason: "The input checkpoint could not be saved. Tool execution is blocked until the workspace recovers." };
      }
    });
  };
}
