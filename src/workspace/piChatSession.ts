import { assertExactTools, createAgentBashTool, createOpenRouterModel } from "../orchestration/runner/piShared.ts";
import type { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../logger.ts";
import type { ChatSession, ChatSessionFactory } from "./personalSession.ts";
import type { WorkspaceConfig } from "./config.ts";
import { homeAgentsFilesOverride } from "./home.ts";
import { createSecretGuardExtension } from "./secretGuard.ts";
import { createMemoryGuardExtension } from "./memoryGuard.ts";
import { createCompactionHandoffExtension } from "./memoryFlush.ts";
import { RunLog, type RunRecorder } from "./runLog.ts";
import { observeRuns, type RunObserver } from "./runObserver.ts";
import { chatSessionDir } from "./sessionPaths.ts";
import { KNOWN_PROXIED_TOOLS, type ToolStubs } from "./toolStubs.ts";
import { BackendSelector, CHATGPT_PROVIDER, chatGptSignedIn, createModelFallbackExtension, selectInitialModel } from "./chatgptFallback.ts";

type Settings = Parameters<SettingsManager["applyOverrides"]>[0];

const log = getLogger("workspace.model");
const guardLog = getLogger("workspace.guard");
const memoryLog = getLogger("workspace.memory");

const PROVIDER_ID = "sushii-workspace-openrouter";
const WORKSPACE_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "bash"];

/** Pi's bash under the agent env allowlist, minus PI_* (PI_CODING_AGENT_DIR and PI_SESSION_FILE point at the agent dir).
 *  `WS_RUN_ID` is the run in progress at spawn time, so `ws-runs` can default to it. */
export function createWorkspaceBashTool(cwd: string, currentRunId: () => string | null = () => null) {
  const extraEnv = (): Record<string, string> => {
    const runId = currentRunId();
    return runId ? { WS_RUN_ID: runId } : {};
  };
  return createAgentBashTool(cwd, extraEnv, { dropPrefixes: ["PI_"], exposeSessionEnvironment: false });
}

const runObservers = new WeakMap<object, RunObserver>();

/** The runId of `session`'s run in progress (a subagent's parentRunId); null between runs. */
export function currentRunId(session: ChatSession): string | null {
  return runObservers.get(session)?.currentRunId() ?? null;
}

/** In-memory settings overrides per live session, re-applied after a reload drops them. */
const sessionOverrides = new WeakMap<object, { session: AgentSession; overrides: Settings }>();

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

/** Tokens past which Pi auto-compacts `session` on its current model (shouldCompact in Pi's compaction.js). */
export function compactionTrigger(session: ChatSession): number | null {
  const entry = sessionOverrides.get(session);
  const model = entry?.session.model;
  if (!entry || !model || !(model.contextWindow > 0)) return null;
  const settings = entry.session.settingsManager.getCompactionSettings(model);
  return settings.enabled ? model.contextWindow - settings.reserveTokens : null;
}

// A detour through the non-reasoning OpenRouter model leaves the level at "off", which Pi clamps up to the
// ChatGPT model's lowest effort; reopened sessions restore that clamped level from the transcript.
function restoreChatGptThinking(session: AgentSession): void {
  session.setThinkingLevel(session.settingsManager.getDefaultThinkingLevel() ?? "medium");
}

/** Builds real Pi chat sessions: cwd = HOME, default context-file discovery plus the home context
 *  files, settings.json and auth.json under agentDir. ChatGPT sign-in is the primary model when
 *  configured and signed in; OpenRouter is the fallback. */
export function createPiChatSessionFactory(config: WorkspaceConfig, opts: { runs?: RunRecorder; toolStubs?: ToolStubs } = {}): ChatSessionFactory {
  const runs = opts.runs ?? new RunLog(config.stateDir);
  // Shared across sessions, so a chat/new during a cool-down stays on OpenRouter.
  const selector = new BackendSelector({ primaryEnabled: config.provider === "chatgpt" });

  return async ({ sessionFile }) => {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { modelRuntime, model: openrouterModel, maxTokens } = await createOpenRouterModel({
      agentDir: config.agentDir,
      providerId: PROVIDER_ID,
      providerName: "sushii workspace OpenRouter",
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    const chatgptModel = config.provider === "chatgpt" ? modelRuntime.getModel(CHATGPT_PROVIDER, config.chatgptModel) : undefined;
    const model = await selectInitialModel({
      config,
      runtime: modelRuntime,
      selector,
      primary: chatgptModel,
      fallback: openrouterModel,
      log,
    });

    const cwd = config.home;
    const sessionDir = chatSessionDir(config.agentDir);
    const sessionManager = sessionFile ? SessionManager.open(sessionFile, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);

    // The extension's handlers only run once createAgentSession has returned and set this.
    const sessionRef: { current: AgentSession | null } = { current: null };
    const fallbackExtension = createModelFallbackExtension({
      selector,
      primary: chatgptModel,
      fallback: openrouterModel,
      signedIn: () => chatGptSignedIn(modelRuntime),
      setModel: async (m) => {
        const session = sessionRef.current;
        if (!session) throw new Error("pi chat session not ready");
        await session.setModel(m);
        if (m.provider === CHATGPT_PROVIDER) restoreChatGptThinking(session);
      },
      log,
    });
    const stubs = opts.toolStubs?.binding();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: config.agentDir,
      agentsFilesOverride: homeAgentsFilesOverride(cwd),
      extensionFactories: [
        { name: "sushii-secret-guard", factory: createSecretGuardExtension({ agentDir: config.agentDir, cwd, home: config.home, log: guardLog }) },
        { name: "sushii-model-fallback", factory: fallbackExtension },
        ...(stubs ? [{ name: "sushii-tool-stubs", factory: stubs.factory }] : []),
        { name: "sushii-memory-guard", factory: createMemoryGuardExtension({ home: config.home, cwd, log: memoryLog }) },
        { name: "sushii-compaction-handoff", factory: createCompactionHandoffExtension({ home: config.home, log: memoryLog }) },
      ],
    });
    await loader.reload();

    // In-memory only (session.reload() drops it): a 16k default reserve overflows on a maxTokens-sized turn.
    const settingsManager = SettingsManager.create(cwd, config.agentDir);
    const overrides: Settings = {
      compaction: {
        reserveTokens: maxTokens,
        ...(chatgptModel ? { modelOverrides: { [`${CHATGPT_PROVIDER}/${chatgptModel.id}`]: { reserveTokens: chatgptModel.maxTokens } } } : {}),
      },
    };
    settingsManager.applyOverrides(overrides);
    // Warm requests would spend the ChatGPT subscription. Pi reads the mode only from the shared global
    // settings.json, out of applyOverrides' reach; an instance override also survives session.reload().
    settingsManager.getCacheWarmingMode = () => "off";

    const observerRef: { current: RunObserver | null } = { current: null };
    const bashTool = await createWorkspaceBashTool(cwd, () => observerRef.current?.currentRunId() ?? null);
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
        tools: stubs ? [...WORKSPACE_TOOLS, ...KNOWN_PROXIED_TOOLS] : WORKSPACE_TOOLS,
        customTools: [bashTool],
        excludeTools: ["ask_question"],
        sessionManager,
      }));
      sessionRef.current = session;
      assertExactTools(session, [...WORKSPACE_TOOLS, ...(stubs?.registeredNames() ?? [])], "workspace", [...WORKSPACE_TOOLS, ...(stubs?.offered() ?? [])]);
      stubs?.assertOwned(session, "workspace");
    } catch (err) {
      stubs?.release();
      throw err;
    }
    if (stubs) {
      const dispose = session.dispose.bind(session);
      session.dispose = () => {
        try {
          return dispose();
        } finally {
          stubs.release();
        }
      };
    }
    if (model.provider === CHATGPT_PROVIDER) restoreChatGptThinking(session);

    const file = sessionManager.getSessionFile();
    if (!file) throw new Error("pi chat session has no persisted file");
    sessionOverrides.set(session, { session, overrides });
    const observer = observeRuns(session, { recorder: runs, sessionFile: file, agentName: "main", defaultModel: config.model });
    observerRef.current = observer;
    runObservers.set(session, observer);
    return { session, sessionFile: file, currentRunId: () => observer.currentRunId() };
  };
}
