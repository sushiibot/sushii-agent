import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { WorkspaceTools } from "../../orchestration/workspace/tools.ts";
import { mintWebActor, isVerifiedWebActor } from "./actor.ts";
import { createWebChat } from "./chat.ts";

test("a thread location request posts and resolves in that thread, through its reply endpoint", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  const actor = mintWebActor("owner@example.com");
  const chat = createWebChat({
    db, workspaceEnabled: true,
    link: { topicManage: async () => {}, isOwner: isVerifiedWebActor } as unknown as WorkspaceLink,
    tools: { isOwner: isVerifiedWebActor } as unknown as WorkspaceTools,
  });
  try {
    const create = await chat.threads.handle(new Request("https://agent.example/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ messageId: "", title: "Nearby coffee" }),
    }), "/api/threads", actor);
    const { id } = await create!.json() as { id: string };
    const pending = chat.location.request({ principalId: "owner" } as ConnectionInfo, {
      principalId: "owner", callId: "location-thread", name: "request_current_location",
      agentId: "topic-agent", agentName: "Coffee", parentRunId: "parent",
      origin: { surface: "web", conversationId: id }, args: { reason: "Nearby coffee" },
    });
    // Posting resolves asynchronously and retains the exact surface handle for later resolution.
    await new Promise(resolve => setImmediate(resolve));
    expect(chat.log.list(["approval"])).toHaveLength(0);
    const log = chat.threads.channel(id).log;
    const event = log.list(["approval"])[0]!;
    const { nonce } = event.data as { nonce: string };
    const path = `/api/threads/${id}/chat/location/${nonce}`;
    const reply = await chat.threads.handle(new Request(`https://agent.example${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ status: "shared", latitude: 42.123456, longitude: 8.123456, accuracy: 9, timestamp: Date.now() }),
    }), path, actor);
    expect(reply!.status).toBe(200);
    expect((await pending).ok).toBe(true);
    expect(log.list(["approval_resolved"])).toHaveLength(1);
    expect(chat.log.list(["approval_resolved"])).toHaveLength(0);
    expect(JSON.stringify(log.list(["approval", "approval_resolved"]))).not.toContain("42.123456");
  } finally {
    chat.routes.closeStreams();
    chat.threads.closeStreams();
    db.close();
  }
});
