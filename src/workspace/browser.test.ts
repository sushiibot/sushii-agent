import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BrowserManager, type BrowserDriver } from "./browser.ts";
import { BROWSER_READ } from "../orchestration/browserContracts.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "browser-test-"));
  const calls: { session: string; args: string[] }[] = [];
  let connections = 0;
  const acks: unknown[] = [];
  const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 404 }); }, websocket: {
    open(socket) { socket.send(JSON.stringify({ type: "url", url: "https://example.com/page" })); socket.send(JSON.stringify({ type: "frame", seq: 1, data: "/9j/", metadata: { deviceWidth: 1280, deviceHeight: 800, timestamp: Date.now() } })); },
    message(_socket, data) { acks.push(JSON.parse(String(data))); },
  } });
  let now = Date.now();
  const driver: BrowserDriver = {
    async run(session, args) { calls.push({ session, args }); return args[0] === "stream" ? JSON.stringify({ success: true, data: { port: server.port } }) : "ok"; },
    connect(port) { connections++; return new WebSocket(`ws://127.0.0.1:${port}`); },
  };
  const manager = new BrowserManager(dir, driver, () => now);
  cleanups.push(async () => { await manager.dispose(); server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  return { dir, manager, driver, calls, acks, connections: () => connections, advance: (ms: number) => { now += ms; } };
}

async function command(tool: ToolDefinition, args: string[], signal?: AbortSignal) {
  return tool.execute("test", { args }, signal, undefined, undefined as never);
}

test("sessions belong to separate conversations and close at settlement without closing another browser", async () => {
  const s = setup();
  const main = s.manager.bind("main", () => "run-main");
  const topic = s.manager.bind("topic-a", () => "run-topic");
  await command(main.tool(), ["open", "https://one.example"]);
  await command(topic.tool(), ["open", "https://two.example"]);
  const first = (await s.manager.read("main", false)).status!;
  const second = (await s.manager.read("topic-a", false)).status!;
  expect(first.id).not.toBe(second.id);
  expect(first.runId).toBe("run-main");
  expect(s.calls.filter((c) => c.args[0] === "set").map((c) => c.args)).toEqual([["set", "viewport", "1280", "800"], ["set", "viewport", "1280", "800"]]);
  await main.finish();
  expect((await s.manager.read("main", false)).status?.state).toBe("ended");
  expect((await s.manager.read("topic-a", false)).status?.state).toBe("active");
  expect(s.calls.filter((c) => c.args[0] === "close")).toEqual([{ session: first.id, args: ["close"] }]);
  await command(main.tool(), ["open", "https://three.example"]);
  expect((await s.manager.read("main", false)).status?.id).not.toBe(first.id);
});

test("simultaneous runs in one conversation own separate browsers and reveal the remaining active run", async () => {
  const s = setup();
  const parent = s.manager.bind("main", () => "parent");
  const child = s.manager.bind("main", () => "child");
  await command(parent.tool(), ["open", "https://parent.example"]);
  const parentId = (await s.manager.read("main", false)).status!.id;
  await command(child.tool(), ["open", "https://child.example"]);
  const childId = (await s.manager.read("main", false)).status!.id;
  expect(childId).not.toBe(parentId);
  expect((await s.manager.read("main", false)).status?.runId).toBe("child");
  await child.finish();
  expect((await s.manager.read("main", false)).status?.id).toBe(parentId);
  expect((await s.manager.read("main", false)).status?.state).toBe("active");
  expect(s.calls.filter((c) => c.args[0] === "close")).toEqual([{ session: childId, args: ["close"] }]);
  await parent.finish();
  expect(JSON.parse(readFileSync(join(s.dir, "browser-sessions.json"), "utf8"))).toEqual([]);
});

test("frames are requested only by viewers, remain ephemeral, and disconnect when the viewer leaves", async () => {
  const s = setup();
  const binding = s.manager.bind("main", () => "run");
  await command(binding.tool(), ["open", "https://example.com"]);
  await s.manager.read("main", false);
  expect(s.connections()).toBe(0);
  await s.manager.read("main", true);
  await Bun.sleep(40);
  const view = await s.manager.read("main", true);
  expect(view.frame?.width).toBe(1280);
  expect(view.status?.url).toBe("https://example.com/page");
  await Bun.sleep(20);
  expect(s.acks).toContainEqual({ type: "ack", seq: 1 });
  expect(readFileSync(join(s.dir, "browser-sessions.json"), "utf8")).not.toContain("/9j/");
  s.advance(3000);
  await Bun.sleep(1100);
  expect((await s.manager.read("main", false)).status?.state).toBe("active");
  await s.manager.read("main", true);
  expect(s.connections()).toBe(2);
  await binding.finish();
  expect((await s.manager.read("main", true)).frame?.seq).toBe(1);
});

test("recovery closes only sessions in the owned registry, and invalid principals cannot read frames", async () => {
  const s = setup();
  const name = "sushii-00000000-0000-0000-0000-000000000000";
  writeFileSync(join(s.dir, "browser-sessions.json"), JSON.stringify([name, "default", "my-personal-browser", "../../bad"]));
  await s.manager.recover();
  expect(s.calls).toEqual([{ session: name, args: ["close"] }]);
  expect(JSON.parse(readFileSync(join(s.dir, "browser-sessions.json"), "utf8"))).toEqual([]);
  const read = s.manager.handlers("owner")[BROWSER_READ]!;
  await expect(read({ principalId: "other", conversationId: "main", frames: true })).rejects.toThrow("principal mismatch");
  expect(await read({ principalId: "owner", conversationId: "missing" })).toEqual({ status: null });
});

test("managed commands and Bash cannot hijack other sessions or close every browser", async () => {
  const s = setup();
  const binding = s.manager.bind("main", () => null);
  await expect(command(binding.tool(), ["close", "--all"])).rejects.toThrow("managed local session");
  await expect(command(binding.tool(), ["open", "https://example.com", "--cdp=9222"])).rejects.toThrow("managed local session");
  let env: unknown;
  const bash = binding.wrapBash({ execute: async () => { env = binding.env(); return { content: [], details: {} }; } } as unknown as ToolDefinition);
  await expect(bash.execute("test", { command: "agent-browser --session personal close" }, undefined, undefined, undefined as never)).rejects.toThrow("provided AGENT_BROWSER_SESSION");
  await bash.execute("test", { command: "agent-browser open https://example.com" }, undefined, undefined, undefined as never);
  expect(env).toMatchObject({ AGENT_BROWSER_SESSION: (await s.manager.read("main", false)).status?.id });
  await binding.finish();
  expect(s.calls.some((c) => c.args.includes("--all"))).toBe(false);
});

test("failed and cancelled launches remain owned until cleanup", async () => {
  const s = setup();
  const run = s.driver.run;
  s.driver.run = async (session, args, signal) => { if (args[0] === "open") throw new Error("cancelled"); return run(session, args, signal); };
  const binding = s.manager.bind("main", () => "run");
  await expect(command(binding.tool(), ["open", "https://example.com"])).rejects.toThrow("cancelled");
  const id = (await s.manager.read("main", false)).status!.id;
  await binding.finish();
  expect(s.calls).toContainEqual({ session: id, args: ["close"] });
});
