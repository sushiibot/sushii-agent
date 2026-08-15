import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { buildMcpHttpApp } from "./http.ts";
import { SessionStore } from "./session.ts";

function fakeClient(): Client<true> {
  return { user: { id: "bot1" } } as unknown as Client<true>;
}

describe("/mcp bearer auth", () => {
  test("rejects a request with no Authorization header", async () => {
    const app = buildMcpHttpApp(fakeClient(), new SessionStore());
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  test("rejects an unknown bearer token", async () => {
    const app = buildMcpHttpApp(fakeClient(), new SessionStore());
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("does not 401 a valid, unexpired session token", async () => {
    const sessionStore = new SessionStore();
    const token = sessionStore.mint({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
    });
    const app = buildMcpHttpApp(fakeClient(), sessionStore);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).not.toBe(401);
  });

  test("a request from one session doesn't get torn down by another session's DELETE (per-request transport)", async () => {
    const sessionStore = new SessionStore();
    const tokenA = sessionStore.mint({
      identity: { id: "u1", username: "alice", avatar: null },
      permittedGuildIds: ["guildA"],
    });
    const tokenB = sessionStore.mint({
      identity: { id: "u2", username: "bob", avatar: null },
      permittedGuildIds: ["guildB"],
    });
    const app = buildMcpHttpApp(fakeClient(), sessionStore);

    // A previous shared-transport implementation would have this DELETE tear down
    // every caller's connection (stateless mode has no session id to scope it by).
    await app.request("/mcp", { method: "DELETE", headers: { Authorization: `Bearer ${tokenA}` } });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });
});

describe("RFC 9728 protected-resource metadata", () => {
  test("exposes authorization_servers and resource", async () => {
    const app = buildMcpHttpApp(fakeClient(), new SessionStore());
    const res = await app.request("https://bridge.example.com/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://bridge.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://bridge.example.com"]);
  });
});
