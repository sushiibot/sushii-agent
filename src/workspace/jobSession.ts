import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { assertExactTools, createOpenRouterModel } from "../orchestration/runner/piShared.ts";
import { getLogger } from "../logger.ts";
import type { WorkspaceConfig } from "./config.ts";
import { BackendSelector, CHATGPT_PROVIDER, chatGptSignedIn, createModelFallbackExtension, modelLabel, selectInitialModel } from "./chatgptFallback.ts";
import type { RunRecorder } from "./runLog.ts";
import { observeRuns } from "./runObserver.ts";
import { jobSessionDir } from "./sessionPaths.ts";

const log = getLogger("workspace.job");

const PROVIDER_ID = "sushii-workspace-job-openrouter";
export const JOB_TIMEOUT_MS = 10 * 60_000;

export interface ToolFreeJobInput {
  /** Run-log agent name, "job:<name>". */
  agentName: string;
  /** Replaces Pi's coding-agent system prompt, which describes tools this session doesn't have. */
  systemPrompt: string;
  prompt: string;
  runs: RunRecorder;
  timeoutMs?: number;
}

export interface ToolFreeJobResult {
  text: string;
  /** chat/deliver-style label: `chatgpt/<id>` or the OpenRouter id. */
  model: string;
  sessionFile: string;
}

/** Test seam: the pieces of an AgentSession the job reads. */
type JobSession = Pick<AgentSession, "prompt" | "subscribe" | "abort" | "dispose" | "messages">;

type AssistantMsg = { role: "assistant"; provider?: string; model?: string; stopReason?: string; errorMessage?: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/**
 * One prompt in a fresh, persisted Pi session with no tools, no context files, skills or discovered
 * extensions: a pure text transform. Starts on ChatGPT when signed in (OpenRouter otherwise) and retries
 * once on OpenRouter after a ChatGPT limit/auth failure. Its backend cool-down is its own, not the chat's.
 */
export async function runToolFreeJob(config: WorkspaceConfig, input: ToolFreeJobInput): Promise<ToolFreeJobResult> {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { modelRuntime, model: openrouterModel } = await createOpenRouterModel({
    agentDir: config.agentDir,
    providerId: PROVIDER_ID,
    providerName: "sushii workspace jobs OpenRouter",
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  const selector = new BackendSelector({ primaryEnabled: config.provider === "chatgpt" });
  const chatgptModel = config.provider === "chatgpt" ? modelRuntime.getModel(CHATGPT_PROVIDER, config.chatgptModel) : undefined;
  const model = await selectInitialModel({ config, runtime: modelRuntime, selector, primary: chatgptModel, fallback: openrouterModel, log });

  const cwd = config.home;
  const sessionRef: { current: AgentSession | null } = { current: null };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: config.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => input.systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      {
        name: "sushii-model-fallback",
        factory: createModelFallbackExtension({
          selector,
          primary: chatgptModel,
          fallback: openrouterModel,
          signedIn: () => chatGptSignedIn(modelRuntime),
          setModel: async (m) => {
            if (!sessionRef.current) throw new Error("job session not ready");
            await sessionRef.current.setModel(m);
          },
          log,
        }),
      },
    ],
  });
  await loader.reload();

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  settingsManager.getCacheWarmingMode = () => "off";
  const sessionManager = SessionManager.create(cwd, jobSessionDir(config.agentDir));
  const { session } = await createAgentSession({
    cwd,
    agentDir: config.agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    tools: [],
    noTools: "all",
  });
  sessionRef.current = session;
  assertExactTools(session, [], input.agentName);
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    session.dispose();
    throw new Error(`${input.agentName}: job session has no persisted file`);
  }
  observeRuns(session, { recorder: input.runs, sessionFile, agentName: input.agentName, defaultModel: config.model });
  try {
    const text = await promptToSettle(session, input.prompt, input.timeoutMs ?? JOB_TIMEOUT_MS);
    const last = lastAssistant(session);
    return { text, model: modelLabel(last?.provider ?? model.provider, last?.model ?? model.id), sessionFile };
  } finally {
    session.dispose();
  }
}

function lastAssistant(session: Pick<JobSession, "messages">): AssistantMsg | undefined {
  return (session.messages as Array<{ role: string }>).filter((m): m is AssistantMsg => m.role === "assistant").at(-1);
}

/** Sends `prompt`, waits for the run to settle, and returns the final assistant text; throws on error, abort or timeout. */
export async function promptToSettle(session: JobSession, prompt: string, timeoutMs: number): Promise<string> {
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "agent_settled") settled();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`job did not settle within ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([Promise.all([session.prompt(prompt), done]), timeout]);
  } catch (err) {
    await session.abort().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  const last = lastAssistant(session);
  if (!last) throw new Error("job produced no reply");
  if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(`job reply ${last.stopReason}: ${last.errorMessage ?? "no detail"}`);
  const text = textOf(last.content).trim();
  if (!text) throw new Error("job reply was empty");
  return text;
}
