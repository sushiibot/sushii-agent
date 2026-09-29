import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { ToolContext, ToolEntry, ToolHosts, ToolRegistry } from "../../core/contracts.ts";
import { createToolRegistry, type ToolAvailability } from "../../core/tools/registry.ts";
import { config } from "../../config.ts";
import type { ToolCallParams, ToolCallResult } from "../../orchestration/contracts.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import { handleWorkspaceApprovalButton, type WorkspaceButtonInteraction } from "./workspaceButtons.ts";
import { ACCENT, type Timers } from "./workspaceLink.ts";
import {
  APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_CALL_ID,
  PROXIED_TOOLS,
  TOOL_EXEC_TIMEOUT_MS,
  WorkspaceTools,
  parseApprovalId,
  type AuditLog,
  type ToolCallAudit,
  type WorkspaceToolsOptions,
} from "./workspaceTools.ts";

const P = "drk";
const OWNER_ID = "100000000000000000";
const conn = (): ConnectionInfo => ({ runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" });

function textOf(options: MessageCreateOptions | MessageEditOptions): string {
  return JSON.stringify((options.components ?? []).map((c) => ("toJSON" in c ? c.toJSON() : c)));
}

function accentOf(options: MessageCreateOptions | MessageEditOptions): number | undefined {
  const c = options.components?.[0];
  return (c && "toJSON" in c ? (c.toJSON() as { accent_color?: number }) : undefined)?.accent_color;
}

class FakeChannel {
  sent: MessageCreateOptions[] = [];
  edits: MessageEditOptions[] = [];
  async send(options: MessageCreateOptions) {
    this.sent.push(options);
    return { edit: async (o: MessageEditOptions) => void this.edits.push(o) };
  }
}

class FakeTimers implements Timers {
  handles = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.handles.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.handles.delete(handle as number);
  }
  fire(ms: number): void {
    for (const [id, h] of [...this.handles]) {
      if (h.ms !== ms) continue;
      this.handles.delete(id);
      h.fn();
    }
  }
}

class FakeLog implements AuditLog {
  lines: Array<{ obj: ToolCallAudit; msg: string }> = [];
  info(obj: ToolCallAudit, msg: string): void {
    this.lines.push({ obj, msg });
  }
}

function fakeEntry(name: string, parameters: Record<string, unknown>, run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>) {
  const calls: Array<{ input: Record<string, unknown>; ctx: ToolContext }> = [];
  const entry: ToolEntry<keyof ToolHosts> = {
    name,
    definition: { name, description: `${name} (fake)`, parameters },
    requiresHosts: [],
    async execute(input, ctx) {
      calls.push({ input, ctx });
      return { content: await run(input, ctx) };
    },
  };
  return { entry, calls };
}

function fixedRegistry(entries: ToolEntry<keyof ToolHosts>[]): ToolRegistry {
  return { resolve: () => entries };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await flush();
}

function setup(opts: Partial<WorkspaceToolsOptions> = {}) {
  const channel = new FakeChannel();
  const timers = new FakeTimers();
  const log = new FakeLog();
  const tools = new WorkspaceTools({
    principalId: P,
    ownerUserId: () => OWNER_ID,
    ownerChannel: async () => channel,
    store: {} as WorkspaceToolsOptions["store"],
    memory: { count: () => 0, getServerContext: () => null } as unknown as WorkspaceToolsOptions["memory"],
    timers,
    log,
    ...opts,
  });
  return { tools, channel, timers, log };
}

function call(name: string, args: unknown, extra: Partial<ToolCallParams> = {}): ToolCallParams {
  return { principalId: P, callId: `call-${name}`, name, args, agentId: "main", agentName: "main", ...extra };
}

const ALL_ON: ToolAvailability = { exa: true, grafanaBaseUrl: true, linear: true };

describe("manifest", () => {
  test("a fully configured bot offers exactly the proxied tools, with their schemas and approvals", () => {
    const { tools } = setup({ registry: createToolRegistry(undefined, () => ALL_ON) });
    const manifest = tools.manifest();
    expect(manifest.map((t) => [t.name, t.approval]).sort()).toEqual(
      [
        ["fetch_url_content", "none"],
        ["file_linear_issue", "ask"],
        ["get_issue_status", "none"],
        ["get_trace", "none"],
        ["list_triaged_issues", "none"],
        ["search_logs", "none"],
        ["team_config", "none"],
        ["web_search", "none"],
      ].sort(),
    );
    const search = manifest.find((t) => t.name === "web_search")!;
    expect(search.inputSchema).toMatchObject({ type: "object", required: ["query"] });
    expect(search.description.length).toBeGreaterThan(0);
  });

  test("config gates drop unconfigured tools", () => {
    const names = (a: ToolAvailability) => setup({ registry: createToolRegistry(undefined, () => a) }).tools.manifest().map((t) => t.name).sort();
    expect(names({ exa: false, grafanaBaseUrl: false, linear: false })).toEqual(["team_config"]);
    expect(names({ exa: true, grafanaBaseUrl: false, linear: false })).toEqual(["fetch_url_content", "team_config", "web_search"]);
    expect(names({ exa: false, grafanaBaseUrl: true, linear: false })).toEqual(["get_trace", "search_logs", "team_config"]);
    expect(names({ exa: false, grafanaBaseUrl: false, linear: true })).toEqual(["file_linear_issue", "get_issue_status", "list_triaged_issues", "team_config"]);
  });

  test("no owner configured → no tools", () => {
    const { tools } = setup({ ownerUserId: () => undefined, registry: createToolRegistry(undefined, () => ALL_ON) });
    expect(tools.manifest()).toEqual([]);
  });

  test("a registry tool outside the allowlist is never offered", () => {
    const memory = fakeEntry("memory", { type: "object" }, async () => "x");
    const search = fakeEntry("web_search", { type: "object" }, async () => "x");
    const { tools } = setup({ registry: fixedRegistry([memory.entry, search.entry]) });
    expect(tools.manifest().map((t) => t.name)).toEqual(["web_search"]);
  });
});

describe("tool/call — approval none", () => {
  const prev = { principals: config.principals, teams: config.teams, grafanaBaseUrl: config.grafanaBaseUrl };
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    config.principals = { drk: { owner: true, identities: { discord: OWNER_ID } } };
    config.teams = {};
    config.grafanaBaseUrl = "https://grafana.test";
  });
  afterEach(() => {
    config.principals = prev.principals;
    config.teams = prev.teams;
    config.grafanaBaseUrl = prev.grafanaBaseUrl;
    globalThis.fetch = realFetch;
  });

  test("get_trace runs as the owner against (faked) Grafana and returns the in-process text", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: URL | string) => {
      urls.push(String(url));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const { tools, channel } = setup({ registry: createToolRegistry(undefined, () => ALL_ON) });
    const res = await tools.handleCall(conn(), call("get_trace", { trace_id: "abc123" }));
    expect(res).toEqual({ ok: true, result: "Trace abc123:\nNo trace found with ID abc123." });
    expect(urls[0]).toContain("/api/traces/abc123");
    expect(channel.sent).toHaveLength(0);
  });

  test("team_config: the list and the detail form are both reads, run without a prompt", async () => {
    expect(PROXIED_TOOLS.team_config!({})).toBe("none");
    expect(PROXIED_TOOLS.team_config!({ team: "x" })).toBe("none");
    const { tools, channel } = setup({ registry: createToolRegistry(undefined, () => ALL_ON) });
    const list = await tools.handleCall(conn(), call("team_config", undefined));
    expect(list.ok).toBe(true);
    const detail = await tools.handleCall(conn(), call("team_config", { team: "nope" }));
    expect(detail).toEqual({ ok: true, result: 'No team "nope".' });
    expect(channel.sent).toHaveLength(0);
  });

  test("the tool gets the owner-DM context", async () => {
    const probe = fakeEntry("get_issue_status", { type: "object", properties: { issue_id: { type: "string" } }, required: ["issue_id"] }, async () => "ok");
    const { tools } = setup({ registry: fixedRegistry([probe.entry]) });
    expect(await tools.handleCall(conn(), call("get_issue_status", { issue_id: "ABC-1" }))).toEqual({ ok: true, result: "ok" });
    const ctx = probe.calls[0]!.ctx;
    expect(ctx.space).toEqual({ surface: "discord", spaceId: "dm" });
    expect(ctx.isPrivate).toBe(true);
    expect(ctx.owner?.userId).toBe(OWNER_ID);
  });

  test("a throwing tool → ok:false with its message", async () => {
    const boom = fakeEntry("list_triaged_issues", { type: "object", properties: {} }, async () => {
      throw new Error("linear down");
    });
    const { tools } = setup({ registry: fixedRegistry([boom.entry]) });
    expect(await tools.handleCall(conn(), call("list_triaged_issues", undefined))).toEqual({ ok: false, error: "linear down" });
  });

  test("execution past 120 s → timeout", async () => {
    const hang = fakeEntry("web_search", { type: "object" }, () => new Promise<string>(() => {}));
    const { tools, timers } = setup({ registry: fixedRegistry([hang.entry]) });
    const pending = tools.handleCall(conn(), call("web_search", {}));
    await until(() => [...timers.handles.values()].some((h) => h.ms === TOOL_EXEC_TIMEOUT_MS));
    timers.fire(TOOL_EXEC_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
  });

  test("parallel calls run concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeEntry("web_search", { type: "object" }, async () => {
      await gate;
      return "slow";
    });
    const fast = fakeEntry("fetch_url_content", { type: "object" }, async () => "fast");
    const { tools } = setup({ registry: fixedRegistry([slow.entry, fast.entry]) });
    const a = tools.handleCall(conn(), call("web_search", {}));
    expect(await tools.handleCall(conn(), call("fetch_url_content", {}))).toEqual({ ok: true, result: "fast" });
    release();
    expect(await a).toEqual({ ok: true, result: "slow" });
  });
});

describe("tool/call — rejected without executing", () => {
  const schema = { type: "object", properties: { trace_id: { type: "string" } }, required: ["trace_id"] };

  test("unknown, non-allowlisted, and config-gated names", async () => {
    const memory = fakeEntry("memory", { type: "object" }, async () => "leak");
    const trace = fakeEntry("get_trace", schema, async () => "t");
    const { tools } = setup({ registry: fixedRegistry([memory.entry, trace.entry]) });
    for (const name of ["memory", "update_profile", "dispatch_to_runner", "nope"]) {
      expect(await tools.handleCall(conn(), call(name, {}))).toEqual({ ok: false, error: `unknown tool: ${name}` });
    }
    expect(memory.calls).toHaveLength(0);

    const gated = setup({ registry: createToolRegistry(undefined, () => ({ exa: false, grafanaBaseUrl: false, linear: false })) });
    expect(await gated.tools.handleCall(conn(), call("web_search", { query: "x" }))).toEqual({ ok: false, error: "unknown tool: web_search" });
  });

  test("schema-invalid args", async () => {
    const trace = fakeEntry("get_trace", schema, async () => "t");
    const { tools } = setup({ registry: fixedRegistry([trace.entry]) });
    for (const args of [{}, { trace_id: 5 }, "str", undefined]) {
      const res = await tools.handleCall(conn(), call("get_trace", args));
      expect(res).toEqual({ ok: false, error: "invalid arguments for get_trace" });
    }
    expect(trace.calls).toHaveLength(0);
  });

  test("malformed params and a principal mismatch", async () => {
    const trace = fakeEntry("get_trace", schema, async () => "t");
    const { tools } = setup({ registry: fixedRegistry([trace.entry]) });
    expect((await tools.handleCall(conn(), { name: "get_trace" })).ok).toBe(false);
    expect(await tools.handleCall(conn(), call("get_trace", { trace_id: "a" }, { principalId: "mallory" }))).toEqual({ ok: false, error: "principal mismatch" });
    expect(trace.calls).toHaveLength(0);
  });
});

describe("tool/call — approval ask", () => {
  const linearSchema = {
    type: "object",
    properties: { title: { type: "string" }, description: { type: "string" }, repo_label: { type: "string" } },
    required: ["title", "description", "repo_label"],
  };
  const ARGS = { title: "Crash on login", description: "SECRET_BODY stack trace", repo_label: "sushii-bot" };

  function askSetup() {
    const linear = fakeEntry("file_linear_issue", linearSchema, async (i) => `Filed ENG-1: ${i.title} — https://linear.app/x/ENG-1`);
    const s = setup({ registry: fixedRegistry([linear.entry]) });
    return { ...s, linear };
  }

  test("posts a new warning prompt with the requester, args summary and buttons", async () => {
    const { tools, channel } = askSetup();
    void tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "c1", agentId: "01RUN", agentName: "researcher" }));
    await until(() => channel.sent.length > 0);
    const prompt = channel.sent[0]!;
    const text = textOf(prompt);
    expect(accentOf(prompt)).toBe(ACCENT.warning);
    expect(text).toContain("🙋 Approve action?");
    expect(text).toContain("**file_linear_issue** requested by `researcher` (subagent of main)");
    expect(text).toContain("Crash on login");
    expect(text).toContain("auto-denies in 30 min");
    expect(text).toContain("wsap:c1:approve");
    expect(text).toContain("wsap:c1:deny");
    tools.decide("c1", "deny");
  });

  test("approve runs the tool and edits the prompt to Approved with a result line", async () => {
    const { tools, channel, linear } = askSetup();
    const pending = tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "c1" }));
    await until(() => channel.sent.length > 0);
    expect(textOf(channel.sent[0]!)).not.toContain("subagent");
    expect(linear.calls).toHaveLength(0);
    expect(tools.decide("c1", "approve")).toBe(true);
    expect(await pending).toEqual({ ok: true, result: "Filed ENG-1: Crash on login — https://linear.app/x/ENG-1" });
    expect(linear.calls).toHaveLength(1);
    await until(() => channel.edits.length === 2);
    expect(textOf(channel.edits[0]!)).toContain('"disabled":true');
    const edit = channel.edits[1]!;
    expect(accentOf(edit)).toBe(ACCENT.success);
    expect(textOf(edit)).toContain("✅ Approved");
    expect(textOf(edit)).toContain("Filed ENG-1");
    expect(textOf(edit)).toContain('"disabled":true');
    expect(tools.decide("c1", "approve")).toBe(false);
  });

  test("deny returns denied without running", async () => {
    const { tools, channel, linear } = askSetup();
    const pending = tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "c1" }));
    await until(() => channel.sent.length > 0);
    tools.decide("c1", "deny");
    expect(await pending).toEqual({ ok: false, error: "denied by owner", denied: true });
    expect(linear.calls).toHaveLength(0);
    expect(textOf(channel.edits[0]!)).toContain("❌ Denied");
    expect(accentOf(channel.edits[0]!)).toBe(ACCENT.danger);
  });

  test("no click in 30 min → timed out, denied", async () => {
    const { tools, channel, timers, linear } = askSetup();
    const pending = tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "c1" }));
    await until(() => channel.sent.length > 0 && timers.handles.size > 0);
    timers.fire(APPROVAL_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: "denied by owner", denied: true });
    expect(linear.calls).toHaveLength(0);
    expect(textOf(channel.edits[0]!)).toContain("⌛ Timed out");
    expect(tools.decide("c1", "approve")).toBe(false);
  });

  test("the socket closing expires the pending approval; a late click finds nothing", async () => {
    const { tools, channel, linear } = askSetup();
    const c = conn();
    const other = conn();
    const pending = tools.handleCall(c, call("file_linear_issue", ARGS, { callId: "c1" }));
    await until(() => channel.sent.length > 0);
    tools.onSocketClosed(other);
    expect(channel.edits).toHaveLength(0);
    tools.onSocketClosed(c);
    expect(await pending).toMatchObject({ ok: false, denied: true });
    expect(textOf(channel.edits[0]!)).toContain("⌛ Expired (workspace disconnected)");
    expect(tools.decide("c1", "approve")).toBe(false);
    expect(linear.calls).toHaveLength(0);
  });

  test("a second call with a pending callId is rejected, even while the first prompt is still posting", async () => {
    const { tools, channel, linear } = askSetup();
    const first = tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "dup" }));
    expect(await tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "dup" }))).toEqual({ ok: false, error: "duplicate callId: dup" });
    await until(() => channel.sent.length > 0);
    expect(channel.sent).toHaveLength(1);
    tools.decide("dup", "approve");
    expect((await first).ok).toBe(true);
    expect(linear.calls).toHaveLength(1);
  });

  test("a callId too long for a button is rejected before prompting", async () => {
    const { tools, channel } = askSetup();
    const res = await tools.handleCall(conn(), call("file_linear_issue", ARGS, { callId: "x".repeat(MAX_APPROVAL_CALL_ID + 1) }));
    expect(res.ok).toBe(false);
    expect(channel.sent).toHaveLength(0);
  });
});

describe("audit log", () => {
  test("every call logs the pinned fields and never the args", async () => {
    const linear = fakeEntry("file_linear_issue", { type: "object" }, async () => "Filed ENG-2");
    const { tools, channel, log } = setup({ registry: fixedRegistry([linear.entry]) });
    const pending = tools.handleCall(conn(), call("file_linear_issue", { title: "t", description: "SECRET_BODY" }, { callId: "c9", agentId: "01RUN", agentName: "coder", parentRunId: "main-run" }));
    await until(() => channel.sent.length > 0);
    tools.decide("c9", "deny");
    await pending;
    await tools.handleCall(conn(), call("nope", {}));
    await tools.handleCall(conn(), { name: "get_trace", callId: "bad-1", args: { description: "SECRET_BODY" } });

    expect(log.lines).toHaveLength(3);
    expect(log.lines[2]!.obj).toMatchObject({ principalId: P, name: "get_trace", callId: "bad-1", ok: false, denied: false });
    const [denied, unknown] = log.lines.map((l) => l.obj);
    expect(Object.keys(denied!).sort()).toEqual(["agentId", "agentName", "callId", "denied", "durationMs", "name", "ok", "parentRunId", "principalId"]);
    expect(denied).toMatchObject({ principalId: P, agentId: "01RUN", agentName: "coder", parentRunId: "main-run", name: "file_linear_issue", callId: "c9", ok: false, denied: true });
    expect(typeof denied!.durationMs).toBe("number");
    expect(unknown).toMatchObject({ name: "nope", ok: false, denied: false });
    expect(JSON.stringify(log.lines)).not.toContain("SECRET_BODY");
  });
});

describe("wsap: buttons", () => {
  function fakeInteraction(customId: string, userId = OWNER_ID) {
    const replies: unknown[] = [];
    let updated = false;
    const interaction = {
      customId,
      user: { id: userId },
      reply: async (o: unknown) => void replies.push(o),
      deferUpdate: async () => {
        updated = true;
      },
    } as unknown as WorkspaceButtonInteraction;
    return { interaction, replies, updated: () => updated };
  }

  test("parses callIds that contain colons", () => {
    expect(parseApprovalId("wsap:a:b:c:approve")).toEqual({ callId: "a:b:c", decision: "approve" });
    expect(parseApprovalId("wsap:c1:deny")).toEqual({ callId: "c1", decision: "deny" });
    expect(parseApprovalId("wsap:c1:maybe")).toBeNull();
    expect(parseApprovalId("wsap::approve")).toBeNull();
  });

  test("only the owner can decide", async () => {
    const decided: string[] = [];
    const tools = { decide: (id: string) => (decided.push(id), true) };
    const stranger = fakeInteraction("wsap:c1:approve", "someone");
    await handleWorkspaceApprovalButton(stranger.interaction, { ownerId: OWNER_ID, tools });
    const unset = fakeInteraction("wsap:c1:approve");
    await handleWorkspaceApprovalButton(unset.interaction, { ownerId: undefined, tools });
    expect(decided).toEqual([]);
    expect(JSON.stringify(stranger.replies)).toContain("Only the owner");
  });

  test("the owner's click routes the decision; a stale one answers expired", async () => {
    const decided: Array<[string, string]> = [];
    const tools = { decide: (id: string, d: "approve" | "deny") => (decided.push([id, d]), id === "live:1") };
    const live = fakeInteraction("wsap:live:1:deny");
    await handleWorkspaceApprovalButton(live.interaction, { ownerId: OWNER_ID, tools });
    expect(decided).toEqual([["live:1", "deny"]]);
    expect(live.updated()).toBe(true);
    expect(live.replies).toHaveLength(0);

    const stale = fakeInteraction("wsap:gone:approve");
    await handleWorkspaceApprovalButton(stale.interaction, { ownerId: OWNER_ID, tools });
    expect(stale.updated()).toBe(false);
    expect(JSON.stringify(stale.replies)).toContain("expired");
  });

  test("end to end: a click on a real prompt approves the parked call", async () => {
    const linear = fakeEntry("file_linear_issue", { type: "object" }, async () => "Filed ENG-3");
    const { tools, channel } = setup({ registry: fixedRegistry([linear.entry]) });
    const pending = tools.handleCall(conn(), call("file_linear_issue", {}, { callId: "run-7:tc-2" }));
    await until(() => channel.sent.length > 0);
    const i = fakeInteraction("wsap:run-7:tc-2:approve");
    await handleWorkspaceApprovalButton(i.interaction, { ownerId: OWNER_ID, tools });
    expect(await pending).toEqual({ ok: true, result: "Filed ENG-3" } satisfies ToolCallResult);
  });
});
