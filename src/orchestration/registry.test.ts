import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../db/index.ts";
import { TaskRegistry } from "./registry.ts";
import type { TaskRow } from "./contracts.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function baseRow(): Omit<TaskRow, "id" | "createdAt" | "updatedAt"> {
  return {
    createdBy: "user-1",
    runnerId: "runner-1",
    project: "sushii-agent",
    nativeSessionId: null,
    resumeCursor: null,
    status: "running",
    statusReason: null,
    summary: null,
    spawnedFromSurface: "discord",
    threadRefs: ["thread-1", "thread-2"],
  };
}

describe("TaskRegistry", () => {
  test("create → get round-trips all fields, including threadRefs as string[]", () => {
    const registry = new TaskRegistry(testDb());
    const created = registry.create(baseRow());

    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);

    const fetched = registry.get(created.id);
    expect(fetched).toEqual(created);
    expect(fetched?.threadRefs).toEqual(["thread-1", "thread-2"]);
  });

  test("get returns undefined for an unknown id", () => {
    const registry = new TaskRegistry(testDb());
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("listByPrincipal returns only that principal's tasks", () => {
    const registry = new TaskRegistry(testDb());
    const a = registry.create({ ...baseRow(), createdBy: "user-1" });
    registry.create({ ...baseRow(), createdBy: "user-2" });
    const b = registry.create({ ...baseRow(), createdBy: "user-1" });

    const rows = registry.listByPrincipal("user-1");
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("updateStatus sets status + reason and bumps updatedAt", () => {
    const registry = new TaskRegistry(testDb());
    const created = registry.create(baseRow());

    registry.updateStatus(created.id, "failed", "runner crashed");
    const fetched = registry.get(created.id);
    expect(fetched?.status).toBe("failed");
    expect(fetched?.statusReason).toBe("runner crashed");
  });

  test("setNativeSession and setSummary update their fields independently", () => {
    const registry = new TaskRegistry(testDb());
    const created = registry.create(baseRow());

    registry.setNativeSession(created.id, "native-abc");
    registry.setSummary(created.id, "did the thing");

    const fetched = registry.get(created.id);
    expect(fetched?.nativeSessionId).toBe("native-abc");
    expect(fetched?.summary).toBe("did the thing");
  });
});
