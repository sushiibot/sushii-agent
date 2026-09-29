import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCallParams, ToolManifestEntry } from "../orchestration/contracts.ts";
import { assertExactTools } from "../orchestration/runner/piShared.ts";
import { ConnectionClosedError, NotConnectedError, RequestTimeoutError } from "../orchestration/transport/client.ts";
import { PROXIED_TOOLS } from "../orchestration/workspace/tools.ts";
import type { WorkspaceConfig } from "./config.ts";
import { createPiChatSessionFactory, reloadContext } from "./piChatSession.ts";
import { ASK_TOOL_TIMEOUT_MS, DENIED_TEXT, KNOWN_PROXIED_TOOLS, LINK_CLOSED_TEXT, TOOL_CANCEL_TIMEOUT_MS, TOOL_TIMEOUT_MS, ToolStubs } from "./toolStubs.ts";

const SEARCH_SCHEMA = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const LINEAR_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, description: { type: "string" }, repo_label: { type: "string" } },
  required: ["title", "description", "repo_label"],
  additionalProperties: false,
};
const SEARCH: ToolManifestEntry = { name: "web_search", description: "Search the web.", inputSchema: SEARCH_SCHEMA, approval: "none" };
const LINEAR: ToolManifestEntry = { name: "file_linear_issue", description: "File a Linear issue.", inputSchema: LINEAR_SCHEMA, approval: "ask" };

type Call = { method: string; params: ToolCallParams; timeoutMs: number };

function stubs(reply: (call: Call) => Promise<unknown> = async () => ({ ok: true, result: "done" })) {
  const calls: Call[] = [];
  let seq = 0;
  const s = new ToolStubs({
    principalId: "drk",
    newId: () => `01CALL${++seq}`,
    request: (method, params, timeoutMs) => {
      const call = { method, params: params as ToolCallParams, timeoutMs };
      calls.push(call);
      return reply(call);
    },
  });
  return { s, calls };
}

function run(def: ToolDefinition, args: unknown, signal?: AbortSignal) {
  return def.execute("tc1", args as never, signal, undefined, undefined as never);
}

function byName(s: ToolStubs, name: string, ctx?: Parameters<ToolStubs["definitions"]>[0]): ToolDefinition {
  const def = s.definitions(ctx).find((d) => d.name === name);
  if (!def) throw new Error(`no stub ${name}`);
  return def;
}

describe("manifest → stubs", () => {
  test("the known names match the bot's proxied tools", () => {
    expect([...KNOWN_PROXIED_TOOLS].sort()).toEqual(Object.keys(PROXIED_TOOLS).sort());
  });

  test("one stub per known manifest entry, carrying its name, description and schema", () => {
    const { s } = stubs();
    s.update([SEARCH, LINEAR, { ...SEARCH, name: "brand_new_tool" }]);
    const defs = s.definitions();
    expect(defs.map((d) => d.name)).toEqual(["web_search", "file_linear_issue"]);
    expect(defs[0]).toMatchObject({ name: "web_search", label: "web_search", description: "Search the web.", parameters: SEARCH_SCHEMA });
    expect(defs[1]!.parameters).toEqual(LINEAR_SCHEMA as unknown as ToolDefinition["parameters"]);
    expect(defs[1]!.promptSnippet).toContain("approval");
  });
});

describe("bindings", () => {
  function fakePi(fail: () => Error | null = () => null) {
    const tools = new Map<string, ToolDefinition>();
    const api = {
      registerTool: (def: ToolDefinition) => {
        const err = fail();
        if (err) throw err;
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI;
    return { tools, api };
  }

  test("a registerTool error that isn't Pi's stale-runtime error keeps the binding", () => {
    const { s } = stubs();
    let failing = true;
    const pi = fakePi(() => (failing ? new Error("system prompt rebuild failed") : null));
    s.binding().factory(pi.api);
    s.update([SEARCH]);
    failing = false;
    s.update([SEARCH, LINEAR]);
    expect([...pi.tools.keys()].sort()).toEqual(["file_linear_issue", "web_search"]);
  });

  test("a released binding gets no further updates", () => {
    const { s } = stubs();
    const pi = fakePi();
    const b = s.binding();
    b.factory(pi.api);
    s.update([SEARCH]);
    b.release();
    s.update([SEARCH, LINEAR]);
    expect([...pi.tools.keys()]).toEqual(["web_search"]);
  });
});

describe("stub execute", () => {
  test("sends one tool/call as the main agent with the args exactly as given", async () => {
    const { s, calls } = stubs();
    s.update([SEARCH]);
    const res = await run(byName(s, "web_search"), { query: "bun", extra: 1 });
    expect(res.content).toEqual([{ type: "text", text: "done" }]);
    expect(calls).toEqual([
      {
        method: "tool/call",
        params: { principalId: "drk", callId: "01CALL1", name: "web_search", args: { query: "bun", extra: 1 }, agentId: "main", agentName: "main" },
        timeoutMs: TOOL_TIMEOUT_MS,
      },
    ]);
  });

  test("a subagent context sets agentId, agentName and parentRunId", async () => {
    const { s, calls } = stubs();
    s.update([SEARCH]);
    await run(byName(s, "web_search", { agentId: "run-7", agentName: "researcher", parentRunId: "run-1" }), { query: "x" });
    expect(calls[0]!.params).toMatchObject({ agentId: "run-7", agentName: "researcher", parentRunId: "run-1" });
  });

  test("an ask tool waits longer than the bot's approval window plus execution", async () => {
    const { s, calls } = stubs();
    s.update([LINEAR]);
    await run(byName(s, "file_linear_issue"), { title: "t", description: "d", repo_label: "r" });
    expect(calls[0]!.timeoutMs).toBe(ASK_TOOL_TIMEOUT_MS);
    expect(ASK_TOOL_TIMEOUT_MS).toBeGreaterThan(30 * 60_000 + 120_000);
    expect(TOOL_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  test("a denied call tells the model not to retry", async () => {
    const { s } = stubs(async () => ({ ok: false, error: "denied by owner", denied: true }));
    s.update([LINEAR]);
    await expect(run(byName(s, "file_linear_issue"), { title: "t", description: "d", repo_label: "r" })).rejects.toThrow(DENIED_TEXT);
  });

  test("a bot error surfaces its text", async () => {
    const { s } = stubs(async () => ({ ok: false, error: "invalid arguments for web_search" }));
    s.update([SEARCH]);
    await expect(run(byName(s, "web_search"), { query: "x", extra: 1 })).rejects.toThrow("invalid arguments for web_search");
  });

  test("a malformed result is an error", async () => {
    const { s } = stubs(async () => ({ nope: true }));
    s.update([SEARCH]);
    await expect(run(byName(s, "web_search"), { query: "x" })).rejects.toThrow("malformed tool/call result");
  });

  test("a link drop mid-call is reported as maybe-completed and never retried", async () => {
    const { s, calls } = stubs(async () => {
      throw new ConnectionClosedError();
    });
    s.update([LINEAR]);
    await expect(run(byName(s, "file_linear_issue"), { title: "t", description: "d", repo_label: "r" })).rejects.toThrow(LINK_CLOSED_TEXT);
    expect(calls).toHaveLength(1);
  });

  test("not connected and timeout are errors, each after a single attempt", async () => {
    let n = 0;
    const { s, calls } = stubs(async (c) => {
      throw n++ === 0 ? new NotConnectedError() : new RequestTimeoutError(c.timeoutMs);
    });
    s.update([SEARCH]);
    await expect(run(byName(s, "web_search"), { query: "x" })).rejects.toThrow("the call was not sent");
    await expect(run(byName(s, "web_search"), { query: "x" })).rejects.toThrow("within 150 s");
    expect(calls).toHaveLength(2);
  });

  test("a stub for a tool the bot stopped offering refuses without calling", async () => {
    const { s, calls } = stubs();
    s.update([SEARCH]);
    const def = byName(s, "web_search");
    s.update([]);
    await expect(run(def, { query: "x" })).rejects.toThrow("no longer offered");
    expect(calls).toHaveLength(0);
  });

  test("an abort ends the wait without a retry and withdraws the call", async () => {
    const { s, calls } = stubs(async (c) => (c.method === "tool/cancel" ? { cancelled: true } : new Promise(() => {})));
    s.update([LINEAR]);
    const ac = new AbortController();
    const pending = run(byName(s, "file_linear_issue"), { title: "t", description: "d", repo_label: "r" }, ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(calls.map((c) => [c.method, c.params, c.timeoutMs])).toEqual([
      ["tool/call", expect.objectContaining({ callId: "01CALL1" }), ASK_TOOL_TIMEOUT_MS],
      ["tool/cancel", { principalId: "drk", callId: "01CALL1" }, TOOL_CANCEL_TIMEOUT_MS],
    ]);
  });

  test("a cancel that can't be sent is dropped quietly", async () => {
    const { s, calls } = stubs(async (c) => {
      if (c.method === "tool/cancel") throw new NotConnectedError();
      return new Promise(() => {});
    });
    s.update([SEARCH]);
    const ac = new AbortController();
    const pending = run(byName(s, "web_search"), { query: "x" }, ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.method)).toEqual(["tool/call", "tool/cancel"]);
  });

  test("a call aborted before it is sent sends nothing", async () => {
    const { s, calls } = stubs();
    s.update([SEARCH]);
    const ac = new AbortController();
    ac.abort();
    await expect(run(byName(s, "web_search"), { query: "x" }, ac.signal)).rejects.toThrow("aborted");
    expect(calls).toHaveLength(0);
  });

  test("a call that settles normally sends no cancel", async () => {
    const { s, calls } = stubs();
    s.update([SEARCH]);
    await run(byName(s, "web_search"), { query: "x" }, new AbortController().signal);
    expect(calls.map((c) => c.method)).toEqual(["tool/call"]);
  });
});

describe("assertExactTools with stubs", () => {
  const fake = (registered: string[], active = registered) => ({
    disposed: false,
    getAllTools: () => registered.map((name) => ({ name })),
    getActiveToolNames: () => active,
    dispose() {
      this.disposed = true;
    },
  });

  test("accepts the built-ins plus the stub names", () => {
    const s = fake(["read", "bash", "web_search"]);
    expect(() => assertExactTools(s, ["read", "bash", "web_search"], "t")).not.toThrow();
  });

  test("still rejects a tool that is neither built-in nor a stub", () => {
    const s = fake(["read", "bash", "web_search", "codemode"]);
    expect(() => assertExactTools(s, ["read", "bash", "web_search"], "t")).toThrow("unexpected pi tool set");
    expect(s.disposed).toBe(true);
  });

  test("a registered-but-inactive stub needs the separate active list", () => {
    const s = fake(["read", "web_search"], ["read"]);
    expect(() => assertExactTools(s, ["read", "web_search"], "t", ["read"])).not.toThrow();
    expect(() => assertExactTools(fake(["read", "web_search"], ["read"]), ["read", "web_search"], "t")).toThrow();
  });
});

describe("real Pi session", () => {
  let root: string;
  const realFetch = globalThis.fetch;
  const BUILTINS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ws-stubs-"));
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  async function session(toolStubs: ToolStubs): Promise<AgentSession> {
    const config = {
      model: "test/model",
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:9/v1",
      agentDir: join(root, "agent"),
      home: join(root, "home"),
      stateDir: join(root, "state"),
    } as WorkspaceConfig;
    const { session } = await createPiChatSessionFactory(config, { toolStubs })({ sessionFile: null });
    return session as AgentSession;
  }

  const active = (s: AgentSession) => [...s.getActiveToolNames()].sort();

  test("a manifest known at creation is registered and active", async () => {
    const { s } = stubs();
    s.update([SEARCH]);
    const pi = await session(s);
    expect(active(pi)).toEqual([...BUILTINS, "web_search"].sort());
    pi.dispose();
  });

  test("manifest changes on re-register update the live session's tools for the next turn", async () => {
    const { s, calls } = stubs();
    const pi = await session(s);
    expect(active(pi)).toEqual(BUILTINS);

    s.update([SEARCH, LINEAR]);
    expect(active(pi)).toEqual([...BUILTINS, "file_linear_issue", "web_search"].sort());
    await pi.getToolDefinition("web_search")!.execute("tc", { query: "q" } as never, undefined, undefined, undefined as never);
    expect(calls[0]!.params).toMatchObject({ name: "web_search", agentId: "main", args: { query: "q" } });

    s.update([{ ...SEARCH, description: "Search the web, v2." }, LINEAR]);
    expect(pi.getToolDefinition("web_search")!.description).toBe("Search the web, v2.");

    s.update([LINEAR]);
    expect(active(pi)).toEqual([...BUILTINS, "file_linear_issue"].sort());
    s.update([SEARCH, LINEAR]);
    expect(active(pi)).toEqual([...BUILTINS, "file_linear_issue", "web_search"].sort());
    s.update([LINEAR]);

    await reloadContext(pi);
    expect(active(pi)).toEqual([...BUILTINS, "file_linear_issue"].sort());
    s.update([LINEAR, SEARCH]);
    expect(active(pi)).toEqual([...BUILTINS, "file_linear_issue", "web_search"].sort());
    pi.dispose();
  });

  test("disposing the session mid-call withdraws the pending tool/call", async () => {
    const { s, calls } = stubs(async (c) => (c.method === "tool/cancel" ? { cancelled: true } : new Promise(() => {})));
    s.update([LINEAR]);
    const pi = await session(s);
    const faux = createFauxCore({ provider: "test", models: [{ id: "model" }] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("file_linear_issue", { title: "t", description: "d", repo_label: "r" }), { stopReason: "toolUse" })]);
    pi.agent.streamFunction = faux.streamSimple as typeof pi.agent.streamFunction;
    const run = pi.prompt("file it").catch(() => {});
    for (let i = 0; i < 200 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls.map((c) => c.method)).toEqual(["tool/call"]);
    pi.dispose();
    await run;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => [c.method, c.params.callId])).toEqual([
      ["tool/call", "01CALL1"],
      ["tool/cancel", "01CALL1"],
    ]);
  });

  test("a manifest update that lands mid-reload is applied once the reload finishes, and later ones still reach the session", async () => {
    const { s } = stubs();
    const pi = await session(s);
    const settings = pi.settingsManager;
    const reloadSettings = settings.reload.bind(settings);
    // Runs after Pi has invalidated the old extension runtime and before the factory re-runs.
    settings.reload = async () => {
      s.update([SEARCH]);
      return reloadSettings();
    };
    await reloadContext(pi);
    settings.reload = reloadSettings;
    expect(active(pi)).toEqual([...BUILTINS, "web_search"].sort());
    s.update([SEARCH, LINEAR]);
    expect(active(pi)).toEqual([...BUILTINS, "file_linear_issue", "web_search"].sort());
    pi.dispose();
  });

  test("a disposed session's binding is dropped on the next update", async () => {
    const { s } = stubs();
    const pi = await session(s);
    pi.dispose();
    expect(() => s.update([SEARCH])).not.toThrow();
    const next = await session(s);
    expect(active(next)).toEqual([...BUILTINS, "web_search"].sort());
    next.dispose();
  });
});
