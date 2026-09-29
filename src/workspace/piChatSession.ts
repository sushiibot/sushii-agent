import { join } from "node:path";
import { createAgentBashTool, createOpenRouterModel } from "../orchestration/runner/piShared.ts";
import type { ChatSessionFactory } from "./personalSession.ts";
import type { WorkspaceConfig } from "./config.ts";

const PROVIDER_ID = "sushii-workspace-openrouter";

/** Builds real Pi chat sessions: cwd = HOME, default context-file discovery, settings.json under agentDir. */
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

    const loader = new DefaultResourceLoader({ cwd, agentDir: config.agentDir });
    await loader.reload();

    // In-memory only (session.reload() drops it): a 16k default reserve overflows on a maxTokens-sized turn.
    const settingsManager = SettingsManager.create(cwd, config.agentDir);
    settingsManager.applyOverrides({ compaction: { reserveTokens: maxTokens } });

    const bashTool = await createAgentBashTool(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir: config.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      // Pi filters customTools by this allowlist: "bash" here is the env-allowlisted override.
      tools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
      customTools: [bashTool],
      excludeTools: ["ask_question"],
      sessionManager,
    });

    const file = sessionManager.getSessionFile();
    if (!file) throw new Error("pi chat session has no persisted file");
    return { session, sessionFile: file };
  };
}
