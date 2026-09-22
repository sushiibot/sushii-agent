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
import { createLocalMemoryProvider } from "./core/memory/localMemoryProvider.ts";
import { createMnemosyneMemoryProvider } from "./core/memory/mnemosyne/mnemosyneMemoryProvider.ts";
import { createMnemosyneCallTool } from "./core/memory/mnemosyne/mnemosyneClient.ts";
import { createSummarizeFoldCompactor } from "./core/compaction/index.ts";
import { createModelSummarizer } from "./agent/summarizer.ts";
import { createMemoryDeriver } from "./agent/memoryDeriver.ts";
import type { LanguageModelProvider } from "./core/contracts.ts";
import { BEHAVIOR_INSTRUCTIONS } from "./modules/moderation/prompt.ts";
import { startDiscordSurface } from "./surfaces/discord/gateway.ts";
import { startWikiSyncScheduler } from "./modules/wiki-sync/index.ts";
import { createWikiFsHost } from "./modules/wiki-sync/wikiHost.ts";
import { resolveWikiIdForSource } from "./modules/wiki-sync/sources.ts";
import { getWikiSyncEnabledGuildIds } from "./modules/wiki-sync/guilds.ts";
import type { SlackWikiSyncClient } from "./surfaces/slack/wikiSync.ts";
import { makeCombinedWikiSourceContext } from "./surfaces/wikiSyncFactory.ts";
import { BUZZ_BEHAVIOR_INSTRUCTIONS } from "./surfaces/buzz/prompt.ts";
import { NostrBuzzClient } from "./surfaces/buzz/buzzClient.ts";
import { startBuzzSurface } from "./surfaces/buzz/gateway.ts";
import { registerBuzzProgressHooks } from "./surfaces/buzz/progress.ts";
import { getBuzzCursor, setBuzzCursor } from "./db/buzzState.ts";
import { createSlackApp } from "./surfaces/slack/connection.ts";
import { superviseSlackApp } from "./surfaces/slack/supervisor.ts";
import { startSlackIngestion } from "./surfaces/slack/ingest.ts";
import { startSlackAgentLoop, type SlackAgentClient } from "./surfaces/slack/gateway.ts";
import { registerSlackProgressHooks } from "./surfaces/slack/progress.ts";
import { SLACK_BEHAVIOR_INSTRUCTIONS } from "./surfaces/slack/prompt.ts";
import type { App as SlackApp } from "@slack/bolt";

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
  // Context-management layers, shared by every surface's core. Compaction summarize-folds long
  // histories under budget; the memory provider proactively injects durable per-space facts each turn.
  // Both are multi-tenant by spaceId. The local provider backs onto the existing store (semantic
  // mnemosyne backend swaps in later behind the same interface).
  const compactor = createSummarizeFoldCompactor({ summarize: createModelSummarizer() });
  // Semantic mnemosyne backend when MNEMOSYNE_MCP_URL is set; else the local FTS store. Both
  // satisfy the same MemoryProvider contract, so this is the only wiring difference. Per-call
  // retrieve is best-effort (deadline/error → null), so a slow or down server never blocks a turn.
  const mnemosyneCallTool = config.mnemosyneMcpUrl
    ? createMnemosyneCallTool({ url: config.mnemosyneMcpUrl, token: config.mnemosyneMcpToken })
    : null;
  const memoryProvider = mnemosyneCallTool
    ? createMnemosyneMemoryProvider({ callTool: mnemosyneCallTool })
    : createLocalMemoryProvider(memory);
  // Warm the mnemosyne SSE connection off the reply path. The connect gets the whole Discord gateway
  // handshake below as headroom, so the first turn's retrieve reuses a live connection within its
  // 1.5s deadline instead of racing the (default 5s) connect. No-op/optional: never blocks startup.
  mnemosyneCallTool?.warm();
  // Write-side of first-class memory: derive + persist durable facts from each finished turn, so
  // saving no longer depends on the agent choosing to call the memory tool. Async, off the reply path.
  const memoryDeriver = createMemoryDeriver(memoryProvider);
  hookBus.on("onTurnEnd", memoryDeriver);
  const core = createAgentCore({
    model,
    store,
    memory,
    tools,
    hooks: hookBus,
    behavior: BEHAVIOR_INSTRUCTIONS,
    compactor,
    memoryProvider,
  });

  // A wiki can be fed by several surfaces, so the sweep factory switches on the source's surface.
  // Slack is captured lazily (its client + workspace URL are resolved further down, after auth.test)
  // and read only at sweep time — cron/command sweeps run after startup, so the holder is set by then;
  // an unwired Slack source returns null and is skipped (scheduler handles null gracefully).
  let slackWiki: { client: SlackWikiSyncClient; workspaceUrl: string } | undefined;
  const makeWikiSourceContext = makeCombinedWikiSourceContext({
    discordClient: client as Client<true>,
    getSlack: () => slackWiki,
  });

  startDiscordSurface({ client: client as Client<true>, core, store, memory, hookBus, makeWikiSourceContext });
  await client.login(config.discordBotToken);

  // Non-conversational drivers bootstrap here, not inside a surface, so they don't depend on the
  // Discord gateway lifecycle (C14).
  startWikiSyncScheduler(makeWikiSourceContext);

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
    buzzBus.on("onTurnEnd", memoryDeriver);
    const buzzProgress = registerBuzzProgressHooks(buzzBus);
    const buzzCore = createAgentCore({ model, store, memory, tools, hooks: buzzBus, behavior: BUZZ_BEHAVIOR_INSTRUCTIONS, compactor, memoryProvider });
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

  // Third surface: Slack (Phase 1 = raw ingestion only). The app is constructed once so a later
  // phase can attach an agent-loop consumer to the same instance before start(). Disabled unless
  // both tokens are set; any Slack failure is isolated so it can't take down Discord/buzz.
  let slackApp: SlackApp | undefined;
  if (config.slack.botToken && config.slack.appToken) {
    try {
      const slack = createSlackApp({ botToken: config.slack.botToken, appToken: config.slack.appToken });
      slackApp = slack.app;
      // Phase 1: durable ingestion of every message. Registered first, coexists with the agent loop.
      startSlackIngestion(slackApp, { db });

      // Phase 2: the agent loop, on its own hook bus + core (sharing store/memory/tools/model), so its
      // live tool-progress and never-silent failures match Discord/buzz. The workspace team id scopes
      // memory + server context (analogous to a Discord guild); DMs wall off via isPrivate.
      const slackBus = createHookBus();
      slackBus.on("onTurnEnd", memoryDeriver);
      const slackProgress = registerSlackProgressHooks(slackBus);
      const slackCore = createAgentCore({ model, store, memory, tools, hooks: slackBus, behavior: SLACK_BEHAVIOR_INSTRUCTIONS, compactor, memoryProvider });
      const auth = await slackApp.client.auth.test();
      const selfId = auth.user_id as string;
      const selfName = (auth.user as string) ?? "sushii";
      const teamId = auth.team_id as string;
      // Wire Slack as a wiki-sync source. auth.test().url is the workspace base URL (ends in "/"),
      // the prefix for archive permalinks. The combined factory reads this on the next sweep.
      if (auth.url) slackWiki = { client: slackApp.client as unknown as SlackWikiSyncClient, workspaceUrl: auth.url as string };
      // Expose read access to the wiki this workspace feeds (if any), mirroring buzz's per-community
      // wiki fs host — the Slack agent reads exactly the wiki it contributes to.
      const slackWikiId = resolveWikiIdForSource("slack", teamId);
      const slackFsHost = slackWikiId ? createWikiFsHost(slackWikiId) : undefined;
      startSlackAgentLoop(slackApp, {
        core: slackCore,
        client: slackApp.client as unknown as SlackAgentClient,
        selfId,
        selfName,
        teamId,
        progress: slackProgress,
        fsHost: slackFsHost,
      });

      superviseSlackApp(slackApp, slack.receiver, { logger });
      slackApp.start().catch((err) => logger.error({ err }, "Slack Socket Mode failed to start"));
      logger.info({ selfId, teamId }, "Slack ingestion + agent-loop surfaces started");
    } catch (err) {
      logger.error({ err }, "Slack surface failed to start");
      slackApp = undefined;
    }
  } else {
    logger.info("SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set — Slack surface disabled");
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
    try {
      await slackApp?.stop();
    } catch (err) {
      logger.error({ err }, "Slack app stop failed");
    }
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
