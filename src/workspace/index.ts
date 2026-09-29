import { OrchestrationClient } from "../orchestration/transport/client.ts";
import { getLogger } from "../logger.ts";
import { WorkspaceConfigError, loadWorkspaceConfig, type WorkspaceConfig } from "./config.ts";
import { PersonalSession } from "./personalSession.ts";
import { createPiChatSessionFactory } from "./piChatSession.ts";

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
  let client: OrchestrationClient | null = null;
  const personal = new PersonalSession({
    principalId: config.principalId,
    model: config.model,
    stateDir: config.stateDir,
    factory: createPiChatSessionFactory(config),
    transport: {
      request: (method, params) => (client ? client.request(method, params) : Promise.reject(new Error("not connected"))),
      notify: (method, params) => client?.notify(method, params),
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
    onRegistered: () => personal.resendUnacked(),
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "workspace shutting down");
    client?.close();
    await personal.dispose();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info({ url: config.orchUrl, principalId: config.principalId, model: config.model }, "workspace starting");
  await client.run();
}

main().catch((err) => {
  log.fatal({ err }, "workspace crashed");
  process.exit(1);
});
