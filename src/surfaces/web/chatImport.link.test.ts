import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { OrchestrationClient } from "../../orchestration/transport/client.ts";
import { OrchestrationServer } from "../../orchestration/transport/server.ts";
import { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import { SurfaceRegistry } from "../../orchestration/workspace/surface.ts";
import { ChatExportReader, chatExportHandlers } from "../../workspace/chatExport.ts";
import { createPiChatImporter } from "./chatImport.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { createChatRoutes, type ChatRouteLink } from "./chatRoutes.ts";
import type { HistoryResponse } from "./events.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPeerMatcher } from "./peers.ts";
import { createPresence } from "./presence.ts";
import { createWebHandler } from "./server.ts";
import { WebWorkspaceAdapter } from "./workspaceAdapter.ts";

// Real workspace export reader and RPC handler on one side of a real WS link, the bot's importer and chat routes on the other.

const P = "drk";
const SECRET = "chat-import-secret";
const OWNER = "owner@example.com";
const GW = "172.31.250.1";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function writeSession(agentDir: string, base: string, texts: string[]): void {
  const lines: object[] = [{ type: "session", version: 3, id: base, timestamp: "2025-09-30T10:00:00.000Z", cwd: "/home" }];
  let parentId: string | null = null;
  texts.forEach((t, i) => {
    const id = `${base.slice(-1)}${i}`;
    const role = i % 2 === 0 ? "user" : "assistant";
    const text = role === "user" ? `[discord:1 2025-09-30 10:00 UTC]\n${t}` : t;
    const timestamp = new Date(Date.UTC(2025, 8, 30, 10, 0, lines.length)).toISOString();
    lines.push({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop" } : {}) } });
    parentId = id;
  });
  writeFileSync(join(agentDir, "chat", `${base}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("pre-web chat import, workspace to bot", () => {
  test("the export pages across session files into the bot's log, which history then serves before live messages", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "chat-import-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    mkdirSync(join(agentDir, "chat"));
    writeSession(agentDir, "2025-09-29T10-00-00-000Z_a", ["a1", "A1", "a2", "A2"]);
    writeSession(agentDir, "2025-09-30T10-00-00-000Z_b", ["b1", "B1"]);

    const server = new OrchestrationServer({ port: 0, secretGrants: { [SECRET]: { principalId: P } } });
    const db = new Database(":memory:");
    applySchema(db);
    const log = new SqliteChatLog(db);
    const inbound = new WebInboundStore(db);
    const presence = createPresence({ head: () => log.head() });
    const adapter = new WebWorkspaceAdapter({ log, inbound, presence });
    const link = new WorkspaceLink({ principalId: P, store: new WorkspaceLinkStore(db), surfaces: new SurfaceRegistry("web", { pinned: true }).register(adapter), owner: () => ({ id: "", name: "drk" }) });
    link.attach(server);
    const port = server.listen().port!;
    cleanups.push(() => server.stop());

    const client = new OrchestrationClient({
      url: `ws://localhost:${port}`,
      runnerId: `workspace-${P}`,
      kind: "pi-workspace",
      secret: SECRET,
      principalId: P,
      heartbeatMs: 0,
      handlers: chatExportHandlers({ principalId: P, reader: new ChatExportReader({ agentDir }) }),
    });
    void client.run();
    cleanups.push(() => client.close());
    await waitFor(() => link.isConnected());

    const routes = createChatRoutes({
      log,
      inbound,
      adapter,
      presence,
      link: link as unknown as ChatRouteLink,
      tools: { decide: () => "forbidden" as const },
      workspaceEnabled: true,
    });
    const config: WebConfig = { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: "/nonexistent", devLogin: undefined, trustedPeers: [GW], push: undefined };
    const handler = createWebHandler({ config, peers: createPeerMatcher(config.trustedPeers), chat: routes });
    const get = (path: string) => handler(new Request(`http://agent.example${path}`, { headers: { "Tailscale-User-Login": OWNER, "Sec-Fetch-Site": "same-origin" } }), GW);

    log.append("user", { key: "01J9Z3W8K2M4N6P8Q0R2S4T6V8", text: "live", uploadIds: [], at: new Date().toISOString() }, "01J9Z3W8K2M4N6P8Q0R2S4T6V8");
    const importer = createPiChatImporter({ db, log, source: link });
    await importer.run();
    await importer.run();

    const texts: string[] = [];
    let before: string | null = null;
    do {
      const res = await get(`/api/chat/history?limit=4${before !== null ? `&before=${before}` : ""}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as HistoryResponse;
      texts.unshift(...page.items.map((i) => (i.type === "user" || i.type === "assistant" ? i.text : i.type)));
      before = page.before;
    } while (before !== null);
    expect(texts).toEqual(["a1", "A1", "a2", "A2", "b1", "B1", "live"]);
  });
});
