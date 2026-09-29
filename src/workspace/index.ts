// First: initialises OTel (when OTEL_EXPORTER_OTLP_ENDPOINT is set) before anything creates spans.
import { otelSDK } from "../telemetry.ts";
import { NotConnectedError, OrchestrationClient } from "../orchestration/transport/client.ts";
import { getLogger } from "../logger.ts";
import { WorkspaceConfigError, loadWorkspaceConfig, type WorkspaceConfig } from "./config.ts";
import { PersonalSession } from "./personalSession.ts";
import { compactionTrigger, createPiChatSessionFactory, reloadContext } from "./piChatSession.ts";
import { commitHome, scaffoldHome } from "./home.ts";
import { memoryFilesSignature } from "./memoryFlush.ts";
import { RunLog } from "./runLog.ts";
import { ToolStubs } from "./toolStubs.ts";

const log = getLogger("workspace");

function loadConfigOrExit(): WorkspaceConfig {
  try {
    return loadWorkspaceConfig();
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      console.error(`workspace: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  // This is the OpenRouter key; Pi's built-in openai provider would otherwise send it to api.openai.com
  // whenever no ChatGPT login is stored.
  delete process.env.OPENAI_API_KEY;
  await scaffoldHome(config.home);
  // One instance for the whole process: later subagent and job runners record through it too.
  const runs = new RunLog(config.stateDir);
  const orphans = runs.reconcileOrphans();
  if (orphans) log.warn({ orphans }, "closed runs left open by a previous process");
  let client: OrchestrationClient | null = null;
  const toolStubs = new ToolStubs({
    principalId: config.principalId,
    request: (method, params, timeoutMs) => (client ? client.request(method, params, { timeoutMs }) : Promise.reject(new NotConnectedError())),
  });
  const personal = new PersonalSession({
    principalId: config.principalId,
    model: config.model,
    stateDir: config.stateDir,
    factory: createPiChatSessionFactory(config, { runs, toolStubs }),
    memory: {
      compactionTrigger,
      reload: reloadContext,
      commit: (message) => commitHome(message, { home: config.home }),
      signature: () => memoryFilesSignature(config.home),
    },
    transport: {
      request: (method, params) => (client ? client.request(method, params) : Promise.reject(new Error("not connected"))),
      notify: (method, params) => client?.notify(method, params),
      isConnected: () => client?.connected ?? false,
    },
  });
  await personal.start();

  client = new OrchestrationClient({
    url: config.orchUrl,
    runnerId: `workspace-${config.principalId}`,
    kind: "pi-workspace",
    location: "workspace",
    ownerOnly: true,
    role: "workspace",
    secret: config.orchSecret,
    principalId: config.principalId,
    state: () => personal.state,
    handlers: personal.handlers(),
    onRegistered: (result) => {
      toolStubs.update(result?.tools ?? []);
      personal.onRegistered();
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "workspace shutting down");
    client?.close();
    await personal.dispose();
    await otelSDK?.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info(
    { url: config.orchUrl, principalId: config.principalId, provider: config.provider, chatgptModel: config.chatgptModel, model: config.model },
    "workspace starting",
  );
  await client.run();
}

main().catch((err) => {
  log.fatal({ err }, "workspace crashed");
  process.exit(1);
});
