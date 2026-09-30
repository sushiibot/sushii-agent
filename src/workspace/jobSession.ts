import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assertExactTools, createOpenRouterModel } from "../agentRuntime/piShared.ts";
import { getLogger } from "../logger.ts";
import type { WorkspaceConfig } from "./config.ts";
import {
  type BackendSelector,
  CHATGPT_PROVIDER,
  chatGptSignedIn,
  createModelFallbackExtension,
  modelLabel,
  restoreChatGptThinking,
  selectInitialModel,
} from "./chatgptFallback.ts";
import type { RunRecorder } from "./runLog.ts";
import { observeRuns } from "./runObserver.ts";
import { jobSessionDir } from "./sessionPaths.ts";
import { USER_MD_CAP, capContent } from "./home.ts";
import { createMemoryGuardExtension } from "./memoryGuard.ts";
import { createSecretGuardExtension } from "./secretGuard.ts";
import { KNOWN_PROXIED_TOOLS, type ToolStubs } from "./toolStubs.ts";

const log = getLogger("workspace.job");

/** Read-only builtins; a job never gets bash, edit or write. */
export const JOB_READ_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Home-relative files a job may load into its system prompt, with their caps. */
const JOB_CONTEXT_CAPS: Record<string, number | undefined> = { "AGENTS.md": undefined, "USER.md": USER_MD_CAP };

const PROVIDER_ID = "sushii-workspace-job-openrouter";
export const JOB_TIMEOUT_MS = 10 * 60_000;

export interface ToolFreeJobInput {
  /** Run-log agent name, "job:<name>". */
  agentName: string;
  /** Replaces Pi's coding-agent system prompt, which describes tools this session doesn't have. */
  systemPrompt: string;
  prompt: string;
  runs: RunRecorder;
  /** The process-wide backend selector the chat session uses too. */
  selector: BackendSelector;
  timeoutMs?: number;
  /** Home files appended to the system prompt, in order; a missing one is skipped. */
  contextFiles?: Array<"AGENTS.md" | "USER.md">;
  /** Read-only tools (read/grep/find/ls, plus the bot-proxied stubs when given) instead of none. */
  readOnlyTools?: { toolStubs?: ToolStubs };
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

/** The system prompt plus the requested home files, each in a `<file>` block. */
export function jobSystemPrompt(home: string, base: string, files: readonly string[] = []): string {
  const blocks: string[] = [];
  for (const name of files) {
    let raw: string;
    try {
      raw = readFileSync(join(home, name), "utf8");
    } catch {
      continue;
    }
    const cap = JOB_CONTEXT_CAPS[name];
    const content = cap === undefined ? raw : capContent(raw, cap).content;
    blocks.push(`<file path="~/${name}">\n${content.trimEnd()}\n</file>`);
  }
  return blocks.length ? `${base}\n\n${blocks.join("\n\n")}` : base;
}

/**
 * One prompt in a fresh, persisted Pi session with no skills or discovered extensions. By default it has no
 * tools and no context files: a pure text transform. `readOnlyTools` adds reads behind the secret guard and
 * a read-only memory guard; `contextFiles` adds home files to the system prompt. Starts on ChatGPT when signed in (OpenRouter otherwise) and retries
 * once on OpenRouter after a ChatGPT limit/auth failure, on the shared selector: a job's failure moves the chat too.
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
  const { selector } = input;
  const chatgptModel = config.provider === "chatgpt" ? modelRuntime.getModel(CHATGPT_PROVIDER, config.chatgptModel) : undefined;
  const model = await selectInitialModel({ config, runtime: modelRuntime, selector, primary: chatgptModel, fallback: openrouterModel, log });

  const cwd = config.home;
  const sessionRef: { current: AgentSession | null } = { current: null };
  const systemPrompt = jobSystemPrompt(config.home, input.systemPrompt, input.contextFiles);
  const withTools = input.readOnlyTools !== undefined;
  // Approval-gated tools would park a job past its own timeout; jobs only get tools that run without asking.
  const jobStubTools = (input.readOnlyTools?.toolStubs
    ? KNOWN_PROXIED_TOOLS.filter((n) => input.readOnlyTools?.toolStubs?.entry(n)?.approval === "none")
    : []) as string[];
  const stubs = input.readOnlyTools?.toolStubs?.binding({ agentId: input.agentName, agentName: input.agentName });
  const guards: { name: string; factory: ExtensionFactory }[] = withTools
    ? [
        { name: "sushii-secret-guard", factory: createSecretGuardExtension({ agentDir: config.agentDir, cwd, home: config.home, log }) },
        ...(stubs ? [{ name: "sushii-tool-stubs", factory: stubs.factory }] : []),
        { name: "sushii-memory-guard", factory: createMemoryGuardExtension({ home: config.home, cwd, readOnly: true, log }) },
      ]
    : [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: config.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      ...guards,
      {
        name: "sushii-model-fallback",
        factory: createModelFallbackExtension({
          selector,
          primary: chatgptModel,
          fallback: openrouterModel,
          signedIn: () => chatGptSignedIn(modelRuntime),
          setModel: async (m) => {
            const session = sessionRef.current;
            if (!session) throw new Error("job session not ready");
            await session.setModel(m);
            if (m.provider === CHATGPT_PROVIDER) restoreChatGptThinking(session);
          },
          log,
        }),
      },
    ],
  });
  // drk's default thinking level from settings.json, which an in-memory manager would not read.
  const defaultThinkingLevel = SettingsManager.create(cwd, config.agentDir).getDefaultThinkingLevel();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}) });
  settingsManager.getCacheWarmingMode = () => "off";
  const sessionManager = SessionManager.create(cwd, jobSessionDir(config.agentDir));
  let session: AgentSession;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir: config.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager,
      ...(withTools
        ? { tools: [...JOB_READ_TOOLS, ...(stubs ? jobStubTools : [])], excludeTools: ["ask_question"] }
        : { tools: [], noTools: "all" as const }),
    }));
    sessionRef.current = session;
    if (model.provider === CHATGPT_PROVIDER) restoreChatGptThinking(session);
    const builtins = withTools ? [...JOB_READ_TOOLS] : [];
    assertExactTools(session, [...builtins, ...(stubs?.registeredNames() ?? [])], input.agentName, [...builtins, ...(stubs?.offered() ?? []).filter((n) => jobStubTools.includes(n))]);
    stubs?.assertOwned(session, input.agentName);
  } catch (err) {
    stubs?.release();
    throw err;
  }
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    session.dispose();
    stubs?.release();
    throw new Error(`${input.agentName}: job session has no persisted file`);
  }
  observeRuns(session, { recorder: input.runs, sessionFile, agentName: input.agentName, defaultModel: config.model });
  try {
    const text = await promptToSettle(session, input.prompt, input.timeoutMs ?? JOB_TIMEOUT_MS);
    const last = lastAssistant(session);
    return { text, model: modelLabel(last?.provider ?? model.provider, last?.model ?? model.id), sessionFile };
  } finally {
    session.dispose();
    stubs?.release();
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
