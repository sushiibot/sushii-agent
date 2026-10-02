import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createReadRoutes, type ReadRouteLink } from "./readRoutes.ts";

test("Memory routes are feature-gated, read-only and map missing files", async () => {
  const db = new Database(":memory:");
  let calls = 0;
  const link = { isConnected: () => true } as ReadRouteLink;
  const memory = {
    memoryRead: async (id?: string) => {
      calls++;
      return id ? null : { files: [], writes: [], truncated: false };
    },
  };
  const base = { db, link, memory, workspaceEnabled: true };
  const off = createReadRoutes({ ...base, features: [] });
  const on = createReadRoutes({ ...base, features: ["memory"] });
  const request = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method });
  expect((await off.handle(request("/api/memory"), "/api/memory"))?.status).toBe(404);
  expect(calls).toBe(0);
  expect((await on.handle(request("/api/memory", "POST"), "/api/memory"))?.status).toBe(405);
  expect((await on.handle(request("/api/memory/writes/foo"), "/api/memory/writes/foo"))?.status).toBe(404);
  expect(calls).toBe(0);
  const overview = await on.handle(request("/api/memory"), "/api/memory");
  expect(await overview?.json()).toEqual({
    files: [],
    writes: [],
    truncated: false,
  });
  expect(overview?.headers.get("Cache-Control")).toContain("no-store");
  expect((await on.handle(request("/api/memory/files/missing"), "/api/memory/files/missing"))?.status).toBe(404);
  expect(calls).toBe(2);
  const offline = createReadRoutes({
    ...base,
    workspaceEnabled: false,
    features: ["memory"],
  });
  expect((await offline.handle(request("/api/memory"), "/api/memory"))?.status).toBe(503);
  expect(calls).toBe(2);
  db.close();
});
