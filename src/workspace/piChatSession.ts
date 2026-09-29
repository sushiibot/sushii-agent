import { join } from "node:path";
import { assertExactTools, createAgentBashTool, createOpenRouterModel } from "../orchestration/runner/piShared.ts";
import type { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ChatSession, ChatSessionFactory } from "./personalSession.ts";
import type { WorkspaceConfig } from "./config.ts";
import { homeAgentsFilesOverride } from "./home.ts";

type Settings = Parameters<SettingsManager["applyOverrides"]>[0];

const PROVIDER_ID = "sushii-workspace-openrouter";
const WORKSPACE_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "bash"];

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

/** Builds real Pi chat sessions: cwd = HOME, default context-file discovery plus the home context
 *  files, settings.json under agentDir. */
export function createPiChatSessionFactory(config: WorkspaceConfig): ChatSessionFactory {
  return async ({ sessionFile }) => {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { modelRuntime, model, maxTokens } = await createOpenRouterModel({
      agentDir: config.agentDir,
      providerId: PROVIDER_ID,
      providerName: "sushii workspace OpenRouter",
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    const cwd = config.home;
    const sessionDir = join(config.agentDir, "chat");
    const sessionManager = sessionFile ? SessionManager.open(sessionFile, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);

    const loader = new DefaultResourceLoader({ cwd, agentDir: config.agentDir, agentsFilesOverride: homeAgentsFilesOverride(cwd) });
    await loader.reload();

    // In-memory only (session.reload() drops it): a 16k default reserve overflows on a maxTokens-sized turn.
    const settingsManager = SettingsManager.create(cwd, config.agentDir);
    const overrides: Settings = { compaction: { reserveTokens: maxTokens } };
    settingsManager.applyOverrides(overrides);

    const bashTool = await createAgentBashTool(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir: config.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      // Pi filters customTools by this allowlist: "bash" here is the env-allowlisted override.
      tools: WORKSPACE_TOOLS,
      customTools: [bashTool],
      excludeTools: ["ask_question"],
      sessionManager,
    });
    assertExactTools(session, WORKSPACE_TOOLS, "workspace");

    const file = sessionManager.getSessionFile();
    if (!file) throw new Error("pi chat session has no persisted file");
    sessionOverrides.set(session, { session, overrides });
    return { session, sessionFile: file };
  };
}
