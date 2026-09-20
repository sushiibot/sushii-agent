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
import { SqliteConversationStore } from "./core/stores/conversationStore.ts";
import { DiscordSpaceMemoryStore } from "./core/stores/memoryStore.ts";
import type { LanguageModelProvider } from "./core/contracts.ts";
import { BEHAVIOR_INSTRUCTIONS } from "./modules/moderation/prompt.ts";
import { startDiscordSurface } from "./surfaces/discord/gateway.ts";
import { startWikiSyncScheduler } from "./modules/wiki-sync/index.ts";
import { createWikiFsHost } from "./modules/wiki-sync/wikiHost.ts";
import { getWikiSyncEnabledGuildIds } from "./modules/wiki-sync/guilds.ts";
import { createDiscordWikiSyncContext } from "./surfaces/discord/wikiSync.ts";
import { BUZZ_BEHAVIOR_INSTRUCTIONS } from "./surfaces/buzz/prompt.ts";
import { NostrBuzzClient } from "./surfaces/buzz/buzzClient.ts";
import { startBuzzSurface } from "./surfaces/buzz/gateway.ts";
import { registerBuzzProgressHooks } from "./surfaces/buzz/progress.ts";
import { getBuzzCursor, setBuzzCursor } from "./db/buzzState.ts";

async function main() {
  logger.info("Starting sushii-agent...");

  await initDb();
  logger.info("Database initialized");

  const db = getDb();
  const store = new SqliteConversationStore(db);
  const memory = new DiscordSpaceMemoryStore(db);
  const hookBus = createHookBus();
  // deps.model is passed straight to the AI SDK's generateText (the core casts it back); it must BE
  // the provider model AND carry contextLimit for the loop's context-ratio budget + the footer.
  const model = Object.assign(openaiProvider(config.openaiModel), { contextLimit: config.openaiContextLimit }) as unknown as LanguageModelProvider;
  // One tool registry (stateless), shared by every surface's core.
  const tools = createToolRegistry();
  const core = createAgentCore({
    model,
    store,
    memory,
    tools,
    hooks: hookBus,
    behavior: BEHAVIOR_INSTRUCTIONS,
  });

  startDiscordSurface({ client: client as Client<true>, core, store, memory, hookBus });
  await client.login(config.discordBotToken);

  // Non-conversational drivers bootstrap here, not inside a surface, so they don't depend on the
  // Discord gateway lifecycle (C14). The capability bag is still Discord-backed for now — a headless
  // impl (buzz/U6) swaps only the factory.
  startWikiSyncScheduler((guildId) => createDiscordWikiSyncContext(client as Client<true>, guildId));

  // Second surface: buzz. A separate AgentCore instance sharing the same store/memory/tools/model,
  // but with a plain buzz behavior (no Discord tokens) and a hookless bus — the Discord-host tools
  // gate off (hosts:{}), so it runs the portable toolset. Disabled unless BUZZ_PRIVATE_KEY is set.
  // One key can serve multiple communities: one poll loop per relay URL, each with its own cursor
  // and memory space (communities are host-scoped and isolated), all sharing the one buzzCore.
  if (config.buzz.privateKey) {
    const privateKey = config.buzz.privateKey;
    // One hook bus + progress registry shared by every relay's surface (all share buzzCore). Wiring
    // the bus is what gives buzz live tool-progress + never-silent failures, parity with Discord.
    const buzzBus = createHookBus();
    const buzzProgress = registerBuzzProgressHooks(buzzBus);
    const buzzCore = createAgentCore({ model, store, memory, tools, hooks: buzzBus, behavior: BUZZ_BEHAVIOR_INSTRUCTIONS });
    // Empty list → one connection on the default relay (dev localhost), keyed "default".
    const relays = config.buzz.relayUrls.length ? config.buzz.relayUrls : [undefined];
    const wikiEnabledGuilds = new Set(getWikiSyncEnabledGuildIds());
    for (const relayUrl of relays) {
      const key = relayUrl ?? "default";
      const spaceId = relayUrl ? `buzz:${key}` : "buzz";
      // buzz media is auth-gated per relay, so each relay's profile points at its own avatar copy.
      const avatarUrl = config.buzz.avatarMap[key] ?? config.buzz.avatarUrl;
      const buzzClient = new NostrBuzzClient({ privateKey, relayUrl, authTag: config.buzz.authTag, avatarUrl }, key);
      // A community reads a wiki only if its relay is mapped, and only that guild's synced wiki.
      const wikiGuildId = config.buzz.wikiMap[key];
      if (wikiGuildId && !wikiEnabledGuilds.has(wikiGuildId)) {
        logger.warn({ relay: key, guildId: wikiGuildId }, "buzz wiki map points at a guild without wiki-sync enabled — its clone may be empty");
      }
      const fsHost = wikiGuildId ? createWikiFsHost(wikiGuildId) : undefined;
      try {
        startBuzzSurface({
          core: buzzCore,
          client: buzzClient,
          cursor: { get: () => getBuzzCursor(db, key), set: (c) => setBuzzCursor(db, key, c) },
          serverContext: { get: () => memory.getServerContext(spaceId), set: (content) => memory.setServerContext(spaceId, content) },
          spaceId,
          displayName: config.buzz.displayName,
          relayLabel: key,
          fsHost,
          progress: buzzProgress,
        });
      } catch (err) {
        // A single unreachable / not-yet-admitted relay must not take down the bot or its siblings.
        logger.error({ err, relay: key }, "buzz surface failed to start for this relay");
      }
    }
  } else {
    logger.info("BUZZ_PRIVATE_KEY not set — buzz surface disabled");
  }

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
