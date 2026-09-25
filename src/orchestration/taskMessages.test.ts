import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../db/index.ts";
import { TaskMessageStore } from "./taskMessages.ts";

function setup() {
  const db = new Database(":memory:");
  applySchema(db);
  db.query(`INSERT INTO tasks (id, created_by, runner_id, status, spawned_from_surface, thread_refs, created_at, updated_at) VALUES ('task-1', 'owner', 'runner', 'running', 'discord', '[]', 1, 1)`).run();
  return { db, store: new TaskMessageStore(db) };
}

describe("TaskMessageStore", () => {
  test("persists addressed pending messages and records delivery/failure separately", () => {
    const { store } = setup();
    const pending = store.create({ id: "message-1", taskId: "task-1", direction: "agent_to_owner", content: "Question?" });
    expect(store.get(pending.id)).toMatchObject({ taskId: "task-1", direction: "agent_to_owner", status: "pending", content: "Question?" });
    store.markDelivered(pending.id, "discord-1");
    expect(store.findByDiscordMessageId("discord-1")).toMatchObject({ status: "delivered", deliveredAt: expect.any(Number) });

    const failed = store.create({ taskId: "task-1", direction: "owner_to_agent", content: "Reply" });
    store.markFailed(failed.id, "runner offline");
    expect(store.get(failed.id)).toMatchObject({ status: "failed", failure: "runner offline", deliveredAt: null });
    expect(store.list("task-1")).toHaveLength(2);
  });

  test("pending agent messages can be recovered after restart", () => {
    const { store } = setup();
    store.create({ id: "pending-1", taskId: "task-1", direction: "agent_to_owner", content: "hello" });
    store.create({ id: "pending-2", taskId: "task-1", direction: "owner_to_agent", content: "reply" });
    expect(store.listPendingAgentMessages().map((m) => m.id)).toEqual(["pending-1"]);
  });
});
