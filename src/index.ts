import { otelSDK } from "./telemetry.ts";
import { initDb, closeDb } from "./db/index.ts";
import { client, startBot } from "./bot.ts";
import logger from "./logger.ts";

async function main() {
  logger.info("Starting sushii-agent...");

  await initDb();
  logger.info("Database initialized");

  await startBot();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    client.destroy();
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
