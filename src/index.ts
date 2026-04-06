import { otelSDK } from "./telemetry.ts";
import { initDb, closeDb } from "./db/index.ts";
import { client, startBot } from "./bot.ts";

async function main() {
  console.log("Starting sushii-agent...");

  await initDb();
  console.log("Database initialized");

  await startBot();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    client.destroy();
    closeDb();
    try {
      await otelSDK?.shutdown();
    } catch (err) {
      console.error("Telemetry flush failed:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
