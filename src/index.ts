import type { Client } from "discord.js";
import { otelSDK } from "./telemetry.ts";
import { initDb, closeDb, getDb } from "./db/index.ts";
import { client } from "./discordClient.ts";
import { config } from "./config.ts";
import { buildMcpHttpApp } from "./mcp/server/http.ts";
import logger from "./logger.ts";
import { openaiProvider } from "./agent/client.ts";
import { createAgentCore } from "./core/agentCore.ts";
import { createHookBus } from "./core/hooks.ts";
import { createToolRegistry } from "./core/tools/registry.ts";
import { DiscordConversationStore } from "./core/stores/conversationStore.ts";
import { DiscordSpaceMemoryStore } from "./core/stores/memoryStore.ts";
import type { LanguageModelProvider } from "./core/contracts.ts";
import { BEHAVIOR_INSTRUCTIONS } from "./modules/moderation/prompt.ts";
import { startDiscordSurface } from "./surfaces/discord/gateway.ts";
import { startWikiSyncScheduler } from "./modules/wiki-sync/index.ts";
import { createDiscordWikiSyncContext } from "./surfaces/discord/wikiSync.ts";

async function main() {
  logger.info("Starting sushii-agent...");

  await initDb();
  logger.info("Database initialized");

  const db = getDb();
  const store = new DiscordConversationStore(db);
  const memory = new DiscordSpaceMemoryStore(db);
  const hookBus = createHookBus();
  // deps.model is passed straight to the AI SDK's generateText (the core casts it back); it must BE
  // the provider model AND carry contextLimit for the loop's context-ratio budget + the footer.
  const model = Object.assign(openaiProvider(config.openaiModel), { contextLimit: config.openaiContextLimit }) as unknown as LanguageModelProvider;
  const core = createAgentCore({
    model,
    store,
    memory,
    tools: createToolRegistry(),
    hooks: hookBus,
    behavior: BEHAVIOR_INSTRUCTIONS,
  });

  startDiscordSurface({ client: client as Client<true>, core, store, memory, hookBus });
  await client.login(config.discordBotToken);

  // Non-conversational drivers bootstrap here, not inside a surface, so they don't depend on the
  // Discord gateway lifecycle (C14). The capability bag is still Discord-backed for now — a headless
  // impl (buzz/U6) swaps only the factory.
  startWikiSyncScheduler((guildId) => createDiscordWikiSyncContext(client as Client<true>, guildId));

  const mcpApp = buildMcpHttpApp(client as Client<true>);
  // MCP clients hold a GET open for server-initiated notifications that this stateless,
  // per-request transport never sends — the default 10s idle timeout logs a warning on every
  // one of those. 60s just quiets that noise; nothing here relies on the connection outliving it.
  const mcpServer = Bun.serve({ port: config.mcpBridgePort, fetch: mcpApp.fetch, idleTimeout: 60 });
  logger.info({ port: mcpServer.port }, "MCP bridge HTTP server listening");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    client.destroy();
    mcpServer.stop();
    closeDb();
    try {
      await otelSDK?.shutdown();
    } catch (err) {
      logger.error({ err }, "Telemetry flush failed");
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
