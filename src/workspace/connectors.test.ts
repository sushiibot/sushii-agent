import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ConnectorManager, connectorUrl, checkPublicHost } from "./connectors.ts";

const dirs: string[] = [];
test("DNS safety accepts public addresses and rejects private or mapped addresses", async () => {
  const resolve = (addresses: { address: string; family: number }[]) => async () => addresses;
  const url = "https://api.fastmail.com/mcp";
  await checkPublicHost(url, resolve([{ address: "103.168.172.38", family: 4 }, { address: "103.168.172.53", family: 4 }]));
  await checkPublicHost(url, resolve([{ address: "2606:4700:4700::1111", family: 6 }]));
  for (const [address, family] of [["127.0.0.1", 4], ["10.0.0.1", 4], ["100.64.0.1", 4], ["::1", 6], ["fc00::1", 6], ["::ffff:103.168.172.38", 6]] as const)
    await expect(checkPublicHost(url, resolve([{ address, family }]))).rejects.toThrow("public HTTPS");
  await expect(checkPublicHost(url, resolve([{ address: "103.168.172.38", family: 4 }, { address: "192.168.1.1", family: 4 }]))).rejects.toThrow("public HTTPS");
  await expect(checkPublicHost(url, resolve([]))).rejects.toThrow("public HTTPS");
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "connectors-"));
  dirs.push(dir);
  let tools: Tool[] = [{ name: "read_email", description: "Read email", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
  const calls: string[] = [];
  const client = {
    close: async () => {},
    listTools: async () => ({ tools }),
    callTool: async ({ name }: { name: string }) => {
      calls.push(name);
      return { content: [{ type: "text", text: "Email content" }] };
    },
  } as unknown as Client;
  const connect = async () => ({ client, tools, transport: {} as StreamableHTTPClientTransport });
  const manager = new ConnectorManager(dir, connect);
  const registered = new Map<string, ToolDefinition>();
  manager.extension({ registerTool: (t: ToolDefinition) => registered.set(t.name, t) } as unknown as ExtensionAPI);
  const call = (id: string, name: string, confirm: boolean | (() => Promise<boolean>) = true) =>
    registered.get("mcp_call_tool")!.execute("call", { serverId: id, tool: name, arguments: {} }, undefined, undefined, {
      hasUI: true,
      ui: { confirm: async () => (typeof confirm === "function" ? confirm() : confirm) },
    } as unknown as ExtensionToolContext);
  const add = async () => {
    const result = await manager.manage({ action: "begin", url: "https://api.fastmail.com/mcp", token: "test-secret" });
    if (result.kind !== "server" || !result.server) throw new Error("No server");
    return result.server;
  };
  return {
    dir,
    manager,
    connect,
    add,
    call,
    calls,
    setTools: (next: Tool[]) => {
      tools = next;
    },
  };
}

test("connection persists without credentials in API responses; disconnect survives restart", async () => {
  const s = setup();
  const server = await s.add();
  expect(JSON.stringify(server)).not.toContain("test-secret");
  expect(statSync(join(s.dir, "connectors.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(s.dir, "connectors.json"), "utf8")).toContain("test-secret");
  await s.manager.manage({ action: "disconnect", id: server.id });
  await expect(s.call(server.id, "read_email")).rejects.toThrow("disconnected");
  const restarted = new ConnectorManager(s.dir, s.connect);
  await restarted.start();
  const result = await restarted.manage({ action: "list" });
  expect(result.kind === "list" && result.servers[0]!.enabled).toBe(false);
  await restarted.manage({ action: "remove", id: server.id });
  expect(readFileSync(join(s.dir, "connectors.json"), "utf8")).not.toContain("test-secret");
});

test("changed schema/description/permissions stay blocked until explicitly accepted", async () => {
  const s = setup();
  const server = await s.add();
  await s.call(server.id, "read_email", false);
  expect(s.calls).toEqual(["read_email"]);
  s.setTools([{ name: "read_email", description: "Changed", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }]);
  await expect(s.call(server.id, "read_email")).rejects.toThrow("changed");
  const detail = await s.manager.manage({ action: "get", id: server.id });
  expect(detail.kind === "server" && detail.server?.toolList[0]?.change).toBe("changed");
  await s.manager.manage({ action: "accept", id: server.id });
  await expect(s.call(server.id, "read_email", false)).rejects.toThrow("approve");
  expect(s.calls).toEqual(["read_email"]);
  await s.call(server.id, "read_email");
  expect(s.calls).toHaveLength(2);
});

test("OAuth state validation rejects unrelated or expired callback addresses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connectors-"));
  dirs.push(dir);
  const manager = new ConnectorManager(dir, async (_saved, provider) => {
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
    throw new Error("needs auth");
  });
  const result = await manager.manage({ action: "begin", url: "https://mail.example.com/mcp" });
  expect(result.kind).toBe("auth");
  await expect(
    manager.manage({ action: "finish", url: "https://mail.example.com/mcp", redirect: "http://localhost:7461/callback?code=x&state=wrong" }),
  ).rejects.toThrow();
  await expect(manager.manage({ action: "finish", url: "https://other.example.com/mcp", redirect: "http://localhost:7461/callback?code=x" })).rejects.toThrow(
    "expired",
  );
});

test("refuses local, non-HTTPS and credential-bearing server addresses", () => {
  for (const url of [
    "http://example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.2/mcp",
    "https://[::1]/mcp",
    "https://a:b@example.com/mcp",
    "https://localhost/mcp",
  ])
    expect(() => connectorUrl(url)).toThrow();
  expect(connectorUrl("https://api.fastmail.com/mcp")).toBe("https://api.fastmail.com/mcp");
});

test("real HTTP transport completes PKCE OAuth, persists credentials and reconnects after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connectors-oauth-"));
  dirs.push(dir);
  let exchange = 0;
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    if (address.includes("oauth-protected-resource"))
      return json({ resource: "https://mail.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    if (address.includes(".well-known/"))
      return json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (address.endsWith("/register")) return json({ ...JSON.parse(String(init?.body)), client_id: "sushii-test" });
    if (address.endsWith("/token")) {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("code")).toBe("valid-code");
      expect(params.get("code_verifier")?.length).toBeGreaterThan(30);
      exchange++;
      return json({ access_token: "oauth-secret", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-secret" });
    }
    if (new Headers(init?.headers).get("Authorization") !== "Bearer oauth-secret")
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource"' },
      });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Mail", version: "1" } }
        : { tools: [{ name: "read_email", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
    return json({ jsonrpc: "2.0", id: body.id, result });
  }) as typeof fetch;
  const manager = new ConnectorManager(dir, undefined, mockFetch);
  const begin = await manager.manage({ action: "begin", url: "https://mail.example.com/mcp" });
  expect(begin.kind).toBe("auth");
  if (begin.kind !== "auth") throw new Error("Expected OAuth");
  const auth = new URL(begin.authUrl);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  await expect(
    manager.manage({ action: "finish", url: "https://mail.example.com/mcp", redirect: "http://localhost:7461/callback?code=valid-code&state=wrong" }),
  ).rejects.toThrow("does not match");
  expect(exchange).toBe(0);
  const result = await manager.manage({
    action: "finish",
    url: "https://mail.example.com/mcp",
    redirect: `http://localhost:7461/callback?code=valid-code&state=${auth.searchParams.get("state")}`,
  });
  expect(result.kind === "server" && result.server?.status).toBe("connected");
  expect(exchange).toBe(1);
  expect(JSON.stringify(result)).not.toContain("oauth-secret");
  await manager.dispose();
  const restarted = new ConnectorManager(dir, undefined, mockFetch);
  await restarted.start();
  const list = await restarted.manage({ action: "list" });
  expect(list.kind === "list" && list.servers[0]?.status).toBe("connected");
  expect(exchange).toBe(1);
  await restarted.dispose();
});

test("replacing credentials preserves the accepted tool snapshot", async () => {
  const s = setup();
  const initial = await s.add();
  s.setTools([{ name: "read_email", description: "New definition", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
  const replacement = await s.add();
  expect(replacement.id).toBe(initial.id);
  expect(replacement.changed).toBe(true);
  await expect(s.call(initial.id, "read_email")).rejects.toThrow("changed");
});

test("a tool change during owner approval cannot authorize the replacement definition", async () => {
  const s = setup();
  s.setTools([{ name: "write_email", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }]);
  const server = await s.add();
  await expect(
    s.call(server.id, "write_email", async () => {
      s.setTools([{ name: "write_email", description: "Changed during approval", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }]);
      await s.manager.manage({ action: "accept", id: server.id });
      return true;
    }),
  ).rejects.toThrow("changed while approval");
  expect(s.calls).toEqual([]);
});
