import { BrowserLocationRequests } from "../../orchestration/workspace/location.ts";
import { WebThreads } from "./threadRoutes.ts";
import type { Database } from "bun:sqlite";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { WorkspaceTools } from "../../orchestration/workspace/tools.ts";
import { getLogger } from "../../logger.ts";
import { createPiChatImporter } from "./chatImport.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { ChatIndex } from "./chatSearch.ts";
import { createChatRoutes, type ChatRoutes } from "./chatRoutes.ts";
import { createHomeRoutes, type HomeRoutes } from "./homeRoutes.ts";
import { WebHomeStore } from "./homeStore.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPresence } from "./presence.ts";
import { sendPush } from "./push.ts";
import { WebWorkspaceAdapter, type WebUploadPort } from "./workspaceAdapter.ts";

const log = getLogger("web/chat");

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const INDEX_CATCH_UP_EVERY_MS = 5 * 60 * 1000;

export interface WebChatDeps {
  db: Database;
  link: WorkspaceLink;
  tools: WorkspaceTools;
  workspaceEnabled: boolean;
  /** Wakes the owner on Discord when an approval push reached no device. */
  breakGlass?: (nonce: string) => Promise<boolean>;
  uploads?: WebUploadPort;
}

export interface WebChat {
  adapter: WebWorkspaceAdapter;
  location: BrowserLocationRequests;
  routes: ChatRoutes;
  home: HomeRoutes;
  threads: WebThreads;
  log: SqliteChatLog;
  /** Starts pruning and workspace-state fan-out; call once the gateway is serving. Returns a stop. */
  start(): () => void;
}

/** Push goes through the gateway's active sender, so until VAPID is configured every push reaches no device. */
export function createWebChat(deps: WebChatDeps): WebChat {
  const chatIndex = new ChatIndex(deps.db);
  const chatLog = new SqliteChatLog(deps.db, { index: chatIndex });
  const inbound = new WebInboundStore(deps.db);
  const presence = createPresence({ head: () => chatLog.head() });
  const homeStore = new WebHomeStore(deps.db);
  const adapter = new WebWorkspaceAdapter({
    log: chatLog,
    inbound,
    presence,
    push: { send: sendPush },
    home: homeStore,
    ...(deps.breakGlass ? { breakGlass: deps.breakGlass } : {}),
    ...(deps.uploads ? { uploads: deps.uploads } : {}),
  });
  const location: BrowserLocationRequests = new BrowserLocationRequests({
    isOwner: (actor) => deps.tools.isOwner(actor),
    prompt: (view, nonce, origin) => surface.approvalPrompt(origin?.surface === "web" ? origin : null, view, nonce),
    resolved: (handle, view, nonce, decision) => surface.resolveApproval(handle as { id: string }, view, nonce, decision),
  });
  // Approvals still undecided here belonged to the previous process, which took their pending state with it.
  const orphaned = chatLog.cancelUnresolvedApprovals();
  if (orphaned) log.info({ count: orphaned }, "cancelled approvals left undecided by the previous process");
  const routes = createChatRoutes({
    log: chatLog,
    inbound,
    adapter,
    presence,
    link: deps.link,
    tools: deps.tools,
    workspaceEnabled: deps.workspaceEnabled,
    location,
    ...(deps.uploads ? { uploads: deps.uploads } : {}),
  });

  const threads = new WebThreads({
    db: deps.db, main: { log: chatLog, adapter, routes }, link: deps.link,
    chat: { link: deps.link, tools: deps.tools, workspaceEnabled: deps.workspaceEnabled, location, ...(deps.uploads ? { uploads: deps.uploads } : {}) },
    adapter: { push: { send: sendPush }, ...(deps.breakGlass ? { breakGlass: deps.breakGlass } : {}), ...(deps.uploads ? { uploads: deps.uploads } : {}) },
  });

  const surface = threads.surface();

  const home = createHomeRoutes({ log: chatLog, adapter, store: homeStore, link: deps.link, workspaceEnabled: deps.workspaceEnabled });

  const importer = createPiChatImporter({ db: deps.db, log: chatLog, source: deps.link });

  let catchingUp = false;
  /** Indexes whatever the live writes missed, imported rows included, a batch per macrotask. */
  async function catchUpIndex(): Promise<void> {
    if (catchingUp) return;
    catchingUp = true;
    try {
      while (chatIndex.catchUp()) await new Promise((r) => setImmediate(r));
    } finally {
      catchingUp = false;
    }
  }

  function prune(): void {
    try {
      const now = Date.now();
      chatLog.prune(now);
      inbound.prune(now);
      homeStore.prune(now);
      void threads.prune().catch(err => log.warn({ err }, "topic maintenance failed"));
    } catch (err) {
      log.warn({ err }, "web chat prune failed");
    }
  }

  return {
    adapter: surface,
    location,
    routes,
    home,
    threads,
    log: chatLog,
    start() {
      prune();
      const timer = setInterval(prune, PRUNE_EVERY_MS);
      timer.unref?.();
      void catchUpIndex();
      const indexTimer = setInterval(() => void catchUpIndex(), INDEX_CATCH_UP_EVERY_MS);
      indexTimer.unref?.();
      const off = deps.link.onConnectionChange((connected) => {
        const ev = { type: "workspace" as const, data: { state: connected && deps.workspaceEnabled ? "online" as const : "offline" as const } };
        chatLog.publish(ev);
        threads.publish(ev);
        if (connected) {
          routes.workspaceConnected();
          threads.workspaceConnected();
          if (deps.workspaceEnabled) void importer.run().then(catchUpIndex);
        }
      });
      // Ephemeral: Home and the Runs list refetch on it, and a missed one only delays that until the next load.
      const offRuns = deps.link.onRunsChanged((r) =>
        chatLog.publish({
          type: "run",
          data: { runId: r.runId, kind: r.kind, status: r.status, ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}), ...(r.jobName ? { jobName: r.jobName } : {}) },
        }),
      );
      if (deps.workspaceEnabled && deps.link.isConnected()) void importer.run().then(catchUpIndex);
      return () => {
        clearInterval(timer);
        clearInterval(indexTimer);
        off();
        offRuns();
        routes.closeStreams();
        threads.closeStreams();
        adapter.close();
      };
    },
  };
}
