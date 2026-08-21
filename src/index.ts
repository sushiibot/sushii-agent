import type { Client } from "discord.js";
import { otelSDK } from "./telemetry.ts";
import { initDb, closeDb } from "./db/index.ts";
import { startBot } from "./bot.ts";
import { client } from "./discordClient.ts";
import { config } from "./config.ts";
import { buildMcpHttpApp } from "./mcp/server/http.ts";
import logger from "./logger.ts";

async function main() {
  logger.info("Starting sushii-agent...");

  await initDb();
  logger.info("Database initialized");

  await startBot();

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
