import type { Database } from "bun:sqlite";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { WorkspaceTools } from "../../orchestration/workspace/tools.ts";
import { getLogger } from "../../logger.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { createChatRoutes, type ChatRoutes } from "./chatRoutes.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPresence } from "./presence.ts";
import { sendPush } from "./push.ts";
import { WebWorkspaceAdapter, type WebUploadPort } from "./workspaceAdapter.ts";

const log = getLogger("web/chat");

const PRUNE_EVERY_MS = 60 * 60 * 1000;

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
  routes: ChatRoutes;
  log: SqliteChatLog;
  /** Starts pruning and workspace-state fan-out; call once the gateway is serving. Returns a stop. */
  start(): () => void;
}

/** Push goes through the gateway's active sender, so until VAPID is configured every push reaches no device. */
export function createWebChat(deps: WebChatDeps): WebChat {
  const chatLog = new SqliteChatLog(deps.db);
  const inbound = new WebInboundStore(deps.db);
  const presence = createPresence({ head: () => chatLog.head() });
  const adapter = new WebWorkspaceAdapter({
    log: chatLog,
    inbound,
    presence,
    push: { send: sendPush },
    ...(deps.breakGlass ? { breakGlass: deps.breakGlass } : {}),
    ...(deps.uploads ? { uploads: deps.uploads } : {}),
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
    ...(deps.uploads ? { uploads: deps.uploads } : {}),
  });

  function prune(): void {
    try {
      const now = Date.now();
      chatLog.prune(now);
      inbound.prune(now);
    } catch (err) {
      log.warn({ err }, "web chat prune failed");
    }
  }

  return {
    adapter,
    routes,
    log: chatLog,
    start() {
      prune();
      const timer = setInterval(prune, PRUNE_EVERY_MS);
      timer.unref?.();
      const off = deps.link.onConnectionChange((connected) => {
        chatLog.publish({ type: "workspace", data: { state: connected && deps.workspaceEnabled ? "online" : "offline" } });
        if (connected) routes.workspaceConnected();
      });
      return () => {
        clearInterval(timer);
        off();
        routes.closeStreams();
        adapter.close();
      };
    },
  };
}
