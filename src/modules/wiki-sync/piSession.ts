import { join } from "node:path";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiRepo } from "./git.ts";
import { commitAndPush } from "./git.ts";
import { WIKI_SYNC_SYSTEM_PROMPT } from "./prompt.ts";

const logger = getLogger("wiki-sync:pi");

const PROVIDER_ID = "sushii-openrouter";

export interface WikiSyncRunResult {
  finalText: string;
  commitSha: string | null;
}

/**
 * Runs one Pi coding-agent turn against the wiki repo checkout. Imports the SDK lazily so its
 * ~14MB of transitive deps only load for guilds that actually have wiki-sync enabled.
 */
export async function runWikiSyncSession(opts: { repo: WikiRepo; prompt: string; guildId: string }): Promise<WikiSyncRunResult> {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, defineTool } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { Type } = await import("typebox");

  let commitSha: string | null = null;
  // Whether the sweep saw an actual commit/push failure (vs. legitimately nothing to commit).
  // sweep.ts only advances its watermark past a batch of messages once the session finishes
  // without one of these — a push failure must not look identical to "nothing changed".
  let commitError: Error | null = null;

  const commitAndPushTool = defineTool({
    name: "commit_and_push",
    label: "Commit & Push",
    description:
      "Stage all changes in the wiki repo, commit with the given message, and push to origin. Call this once, after all edits (including your changelog entry) are done.",
    parameters: Type.Object({
      message: Type.String({ description: "Commit message describing what changed and why." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        commitSha = await commitAndPush(opts.repo, params.message as string);
      } catch (err) {
        commitError = err instanceof Error ? err : new Error(String(err));
        return {
          content: [{ type: "text" as const, text: `Commit/push failed: ${commitError.message}` }],
          details: { sha: null },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: commitSha ? `Committed and pushed as ${commitSha}` : "Nothing to commit — working tree was clean.",
          },
        ],
        details: { sha: commitSha },
      };
    },
  });

  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.wikiSyncAgentDir, "auth.json"),
    modelsPath: join(config.wikiSyncAgentDir, "models.json"),
  });

  // Registered directly on the runtime (not via an extension factory): extensions loaded
  // through a resourceLoader only get bound to a live modelRuntime as part of session
  // creation, which happens after createAgentSession() has already resolved its initial
  // model — registering here first avoids that ordering trap entirely.
  //
  // samplingParams carries OpenRouter's data_collection: "deny" on every request — Discord's
  // ToS requires opting message content out of model training, and Pi's typed provider config
  // has no dedicated field for it (verified against pi-ai's request builder), but samplingParams
  // is merged into the request body as-is for openai-completions providers.
  modelRuntime.registerProvider(PROVIDER_ID, {
    name: "sushii OpenRouter",
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    api: "openai-completions",
    models: [
      {
        id: config.openaiModel,
        name: config.openaiModel,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.openaiContextLimit,
        maxTokens: 8192,
        samplingParams: { provider: { data_collection: "deny" } },
      },
    ],
  });

  const model = modelRuntime.getModel(PROVIDER_ID, config.openaiModel);
  if (!model) throw new Error(`wiki-sync model ${PROVIDER_ID}/${config.openaiModel} failed to register`);

  const loader = new DefaultResourceLoader({
    cwd: opts.repo.dir,
    agentDir: config.wikiSyncAgentDir,
    systemPromptOverride: () => WIKI_SYNC_SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: opts.repo.dir,
    agentDir: config.wikiSyncAgentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    tools: ["read", "edit", "write", "grep", "find", "ls", "commit_and_push"],
    excludeTools: ["bash", "ask_question"],
    customTools: [commitAndPushTool],
    sessionManager: SessionManager.create(opts.repo.dir, join(config.wikiSyncAgentDir, "sessions")),
  });

  let finalText = "";
  session.subscribe((event: { type: string; assistantMessageEvent?: { type: string; delta?: string } }) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta ?? "";
    }
  });

  await session.prompt(opts.prompt);
  session.dispose();

  logger.info({ guildId: opts.guildId, commitSha, finalText: finalText.slice(0, 2000) }, "wiki-sync session finished");

  // Surface a failed push as a thrown error rather than a successful-looking result — tool
  // execution errors are reported back to the model as a turn result, not rethrown out of
  // session.prompt(), so without this a failed push would look identical to "sweep succeeded,
  // nothing to commit" and the caller would advance its watermark past messages that were
  // never actually synced.
  if (commitError) throw commitError;

  return { finalText, commitSha };
}
