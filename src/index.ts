import { initDb, closeDb } from "./db/index.ts";
import { client, startBot } from "./bot.ts";

async function main() {
  console.log("Starting ModAssist...");

  await initDb();
  console.log("Database initialized");

  await startBot();

  const shutdown = () => {
    console.log("Shutting down...");
    client.destroy();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
