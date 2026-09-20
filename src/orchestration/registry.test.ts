import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { applySchema } from "../db/index.ts";
import { TaskNotFoundError, TaskRegistry } from "./registry.ts";
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
    cwd: null,
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
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000_000);
      const registry = new TaskRegistry(testDb());
      const created = registry.create(baseRow());
      expect(created.updatedAt).toBe(created.createdAt);

      clock.mockReturnValue(1_005_000);
      registry.updateStatus(created.id, "failed", "runner crashed");

      const fetched = registry.get(created.id);
      expect(fetched?.status).toBe("failed");
      expect(fetched?.statusReason).toBe("runner crashed");
      expect(fetched?.updatedAt).toBe(1005);
      expect(fetched?.updatedAt).toBeGreaterThanOrEqual(created.createdAt);
    } finally {
      clock.mockRestore();
    }
  });

  test("updateStatus without a reason clears any prior statusReason", () => {
    const registry = new TaskRegistry(testDb());
    const created = registry.create(baseRow());

    registry.updateStatus(created.id, "failed", "runner crashed");
    registry.updateStatus(created.id, "running");

    const fetched = registry.get(created.id);
    expect(fetched?.status).toBe("running");
    expect(fetched?.statusReason).toBeNull();
  });

  test("mutators throw TaskNotFoundError on an unknown id", () => {
    const registry = new TaskRegistry(testDb());
    expect(() => registry.updateStatus("nonexistent", "running")).toThrow(TaskNotFoundError);
    expect(() => registry.setNativeSession("nonexistent", "native-abc")).toThrow(TaskNotFoundError);
    expect(() => registry.setSummary("nonexistent", "summary")).toThrow(TaskNotFoundError);
  });

  test("threadRefs round-trips an empty array", () => {
    const registry = new TaskRegistry(testDb());
    const created = registry.create({ ...baseRow(), threadRefs: [] });

    const fetched = registry.get(created.id);
    expect(fetched?.threadRefs).toEqual([]);
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
