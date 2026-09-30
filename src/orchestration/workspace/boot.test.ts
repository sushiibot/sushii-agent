import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import type { ToolEntry, ToolHosts } from "../../core/contracts.ts";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { mintWebActor } from "../../surfaces/web/actor.ts";
import { RPC_METHODS, type ChatOrigin } from "../contracts.ts";
import type { PrincipalConfig } from "../principals.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../transport/server.ts";
import { bootWorkspace, listenWorkspace, workspaceOwnerCheck, type WorkspaceConfig } from "./boot.ts";
import type { WorkspaceRpc } from "./link.ts";
import type { Timers } from "./progress.ts";
import type {
  AckKind,
  ApprovalDecision,
  ApprovalView,
  InboundMessage,
  ProgressFinal,
  ProgressView,
  RouterNotice,
  SurfaceActor,
  SurfaceAdapter,
  SurfaceCapabilities,
  SurfaceMessageHandle,
} from "./surface.ts";
import { APPROVAL_TIMEOUT_MS } from "./tools.ts";

const P = "drk";
const OWNER_DISCORD = "150";
const OWNER_LOGIN = "Owner@GitHub";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };

/** Records every call, so a test can assert a surface was never used. */
class RecordingAdapter implements SurfaceAdapter {
  calls: Array<{ method: string; origin?: ChatOrigin | null; arg?: unknown }> = [];
  readonly capabilities: SurfaceCapabilities;
  constructor(
    readonly surface: string,
    caps: Partial<SurfaceCapabilities> = {},
  ) {
    this.capabilities = { streaming: true, tables: true, richButtons: true, reactions: false, maxMessageChars: 4000, ...caps };
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
  private rec(method: string, origin?: ChatOrigin | null, arg?: unknown) {
    this.calls.push({ method, origin, arg });
  }
  async sendReply(origin: ChatOrigin | null, reply: unknown) {
    this.rec("sendReply", origin, reply);
  }
  async askPrompt(origin: ChatOrigin | null, ask: unknown) {
    this.rec("askPrompt", origin, ask);
  }
  async authPrompt(origin: ChatOrigin | null, view: unknown) {
    this.rec("authPrompt", origin, view);
  }
  progressEditGap() {
    return 0;
  }
  async progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<SurfaceMessageHandle> {
    this.rec("progressCreate", origin, view.turnId);
    return { id: "p1" };
  }
  async progressUpdate() {
    this.rec("progressUpdate");
  }
  async progressDelta() {
    this.rec("progressDelta");
  }
  async progressFinalize(origin: ChatOrigin | null, _h: SurfaceMessageHandle | null, final: ProgressFinal) {
    this.rec("progressFinalize", origin, final);
  }
  async progressReopen() {
    this.rec("progressReopen");
    return null;
  }
  async approvalPrompt(origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<SurfaceMessageHandle> {
    this.rec("approvalPrompt", origin, { view, nonce });
    return { id: nonce };
  }
  async resolveApproval(_h: SurfaceMessageHandle, _v: ApprovalView, _n: string, decision: ApprovalDecision) {
    this.rec("resolveApproval", null, decision);
  }
  async ack(m: InboundMessage, kind: AckKind) {
    this.rec("ack", m.origin, kind);
  }
  async notice(m: InboundMessage, notice: RouterNotice) {
    this.rec("notice", m.origin, notice);
  }
  async transcribe() {
    return null;
  }
  async fallbackReply(m: InboundMessage, text: string) {
    this.rec("fallbackReply", m.origin, text);
    return null;
  }
  async resetFallback() {}
}

class FakeRpc implements WorkspaceRpc {
  handler: WorkspaceHandler | null = null;
  calls: Array<{ method: string; params: unknown }> = [];
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return principalId === P ? CONN : undefined;
  }
  async requestWorkspace(_p: string, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return {};
  }
  setWorkspaceHandler(handler: WorkspaceHandler | null): void {
    this.handler = handler;
  }
}

class ManualTimers implements Timers {
  handles = new Map<number, { fn: () => void; ms: number }>();
  private seq = 0;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.handles.set(id, { fn, ms });
    return id;
  }
  clear(h: unknown): void {
    this.handles.delete(h as number);
  }
  fire(ms: number): void {
    for (const [id, h] of [...this.handles]) {
      if (h.ms !== ms) continue;
      this.handles.delete(id);
      h.fn();
    }
  }
}

const LINEAR: ToolEntry<keyof ToolHosts> = {
  name: "file_linear_issue",
  definition: {
    name: "file_linear_issue",
    description: "file",
    parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, repo_label: { type: "string" } } },
  },
  requiresHosts: [],
  execute: async () => ({ content: "filed" }),
};

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await tick();
}

function cfg(preferredSurface: string, timers: Timers = new ManualTimers()): WorkspaceConfig {
  const db = new Database(":memory:");
  applySchema(db);
  return {
    principalId: P,
    preferredSurface,
    enabled: true,
    orchPort: 0,
    ownerDiscordId: OWNER_DISCORD,
    store: {} as never,
    memory: { count: () => 0, getServerContext: () => null } as never,
    linkStore: new WorkspaceLinkStore(db),
    github: { handle: async () => ({ ok: false, error: "unconfigured" }) } as never,
    secretGrants: {},
    registry: { resolve: () => [LINEAR] },
    timers,
  };
}

function boot(preferred: string, adapters: SurfaceAdapter[], timers?: Timers) {
  const b = bootWorkspace(cfg(preferred, timers), adapters);
  const rpc = new FakeRpc();
  b.link.attach(rpc);
  const call = (callId: string) =>
    rpc.handler!.onRequest!(CONN, RPC_METHODS.toolCall, { principalId: P, callId, name: "file_linear_issue", args: { title: "T", description: "D", repo_label: "r" }, agentId: "main", agentName: "main" });
  const deliver = (outboxId: string, origin: ChatOrigin | null, kind: "reply" | "ask" = "reply") =>
    b.link.deliver({
      principalId: P,
      outboxId,
      kind,
      text: "hello",
      ...(origin ? { origin } : {}),
      ...(kind === "ask" ? { ask: { askId: "a1", question: "Which?", choices: ["x", "y"] } } : {}),
    } as never);
  return { ...b, rpc, call, deliver };
}

let savedPrincipals: Record<string, PrincipalConfig>;
beforeEach(() => {
  savedPrincipals = config.principals;
  config.principals = { [P]: { owner: true, identities: { discord: OWNER_DISCORD, web: OWNER_LOGIN.toLowerCase() } } };
});
afterEach(() => {
  config.principals = savedPrincipals;
});

describe("workspace owner check", () => {
  const isOwner = workspaceOwnerCheck({ principalId: P, ownerDiscordId: OWNER_DISCORD });

  test("discord: the configured owner id, nobody else", () => {
    expect(isOwner({ surface: "discord", userId: OWNER_DISCORD, name: "drk" })).toBe(true);
    expect(isOwner({ surface: "discord", userId: "999", name: "x" })).toBe(false);
    expect(workspaceOwnerCheck({ principalId: P, ownerDiscordId: undefined })({ surface: "discord", userId: "", name: "" })).toBe(false);
  });

  test("web: only an actor the gateway minted, mapped to the owner through principals", () => {
    expect(isOwner(mintWebActor(OWNER_LOGIN))).toBe(true);
    // Shape alone never counts, even with the owner's exact login.
    expect(isOwner({ surface: "web", userId: OWNER_LOGIN.toLowerCase(), name: "drk" })).toBe(false);
    const minted = mintWebActor(OWNER_LOGIN);
    expect(isOwner({ ...minted })).toBe(false);
    expect(isOwner(mintWebActor("someone-else@github"))).toBe(false);
  });

  test("web: a minted owner login that principals.json doesn't map is refused", () => {
    config.principals = { [P]: { owner: true, identities: { discord: OWNER_DISCORD } } };
    expect(isOwner(mintWebActor(OWNER_LOGIN))).toBe(false);
    config.principals = { other: { owner: true, identities: { web: OWNER_LOGIN.toLowerCase() } } };
    expect(isOwner(mintWebActor(OWNER_LOGIN))).toBe(false);
  });

  test("other surfaces and the web login on another surface are refused", () => {
    expect(isOwner({ surface: "slack", userId: OWNER_DISCORD, name: "drk" })).toBe(false);
    expect(isOwner({ surface: "discord", userId: OWNER_LOGIN.toLowerCase(), name: "drk" })).toBe(false);
  });

  test("the booted tools and link use the same check", () => {
    const b = boot("discord", [new RecordingAdapter("discord")]);
    const forged: SurfaceActor = { surface: "web", userId: OWNER_LOGIN.toLowerCase(), name: "drk" };
    expect(b.link.isOwner(forged)).toBe(false);
    expect(b.tools.isOwner(forged)).toBe(false);
    expect(b.link.isOwner(mintWebActor(OWNER_LOGIN))).toBe(true);
    expect(b.tools.isOwner(mintWebActor(OWNER_LOGIN))).toBe(true);
    expect(b.tools.isOwner({ surface: "discord", userId: OWNER_DISCORD, name: "drk" })).toBe(true);
  });
});

describe("preferred surface web", () => {
  test("a minted web owner decides a web approval; a forged one can't", async () => {
    const web = new RecordingAdapter("web");
    const b = boot("web", [new RecordingAdapter("discord"), web]);
    const pending = b.call("c1");
    await until(() => web.of("approvalPrompt").length > 0);
    const { nonce } = web.of("approvalPrompt")[0]!.arg as { nonce: string };
    expect(b.tools.decide(nonce, "approve", { surface: "web", userId: OWNER_LOGIN.toLowerCase(), name: "drk" })).toBe("forbidden");
    expect(b.tools.decide(nonce, "approve", mintWebActor(OWNER_LOGIN))).toBe("decided");
    expect(await pending).toEqual({ ok: true, result: "filed" });
  });

  test("approvals, asks, replies and progress never go to Discord, even with a discord origin", async () => {
    const discord = new RecordingAdapter("discord");
    const web = new RecordingAdapter("web");
    const b = boot("web", [discord, web]);
    const origin: ChatOrigin = { surface: "discord", conversationId: "dm-1" };
    const pending = b.call("c1");
    await until(() => web.of("approvalPrompt").length > 0);
    await b.deliver("o1", origin);
    await b.deliver("o2", origin, "ask");
    b.rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { principalId: P, agentId: "main", turnId: "t1", origin, ev: { type: "tool_start", name: "bash", summary: "ls" } });
    await until(() => web.of("progressCreate").length > 0);
    expect(discord.calls).toEqual([]);
    expect(web.of("approvalPrompt")[0]!.origin).toBeNull();
    expect(web.of("sendReply").map((c) => c.origin)).toEqual([null]);
    expect(web.of("askPrompt").map((c) => c.origin)).toEqual([null]);
    expect(web.of("progressCreate").map((c) => c.origin)).toEqual([null]);
    const { nonce } = web.of("approvalPrompt")[0]!.arg as { nonce: string };
    b.tools.decide(nonce, "deny", mintWebActor(OWNER_LOGIN));
    expect(await pending).toMatchObject({ denied: true });
  });

  test("web missing: nothing throws, approvals are held then denied, deliveries stay unacked, Discord is never used", async () => {
    const timers = new ManualTimers();
    const discord = new RecordingAdapter("discord");
    const b = boot("web", [discord], timers);
    expect(() => listenWorkspace(b, 0)).not.toThrow();
    try {
      const origin: ChatOrigin = { surface: "discord", conversationId: "dm-1" };
      let settled = false;
      const pending = Promise.resolve(b.call("c1")).then((r) => {
        settled = true;
        return r;
      });
      await b.deliver("o1", origin);
      await b.deliver("o2", null, "ask");
      b.rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { principalId: P, agentId: "main", turnId: "t1", origin, ev: { type: "tool_start", name: "bash", summary: "ls" } });
      b.rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { principalId: P, agentId: "main", turnId: "t1", origin, ev: { type: "turn_end", aborted: true } });
      await b.link.settled();
      await tick();
      expect(settled).toBe(false);
      timers.fire(APPROVAL_TIMEOUT_MS);
      const result = await pending;
      expect(result).toMatchObject({ ok: false, denied: true });
      expect(discord.calls).toEqual([]);
      expect(b.rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck)).toEqual([]);
    } finally {
      b.server.stop();
    }
  });

  test("a held approval is asked on web once the web adapter registers", async () => {
    const discord = new RecordingAdapter("discord");
    const b = boot("web", [discord]);
    const pending = b.call("c1");
    await tick();
    const web = new RecordingAdapter("web");
    b.registry.register(web);
    await until(() => web.of("approvalPrompt").length > 0);
    const { nonce } = web.of("approvalPrompt")[0]!.arg as { nonce: string };
    expect(b.tools.decide(nonce, "approve", mintWebActor(OWNER_LOGIN))).toBe("decided");
    expect(await pending).toEqual({ ok: true, result: "filed" });
    expect(discord.calls).toEqual([]);
  });

  test("a held approval is cancelled by tool/cancel and by a closed socket", async () => {
    const b = boot("web", [new RecordingAdapter("discord")]);
    const cancelled = b.call("c1");
    await tick();
    expect(await b.rpc.handler!.onRequest!(CONN, RPC_METHODS.toolCancel, { principalId: P, callId: "c1" })).toEqual({ cancelled: true });
    expect(await cancelled).toEqual({ ok: false, error: "cancelled" });
    const closed = b.call("c2");
    await tick();
    b.rpc.handler!.onSocketClosed!(CONN);
    expect(await closed).toMatchObject({ ok: false, denied: true });
  });
});

describe("preferred surface discord (rollback)", () => {
  test("approvals and origin-less deliveries still go to Discord", async () => {
    const discord = new RecordingAdapter("discord");
    const b = boot("discord", [discord]);
    const pending = b.call("c1");
    await until(() => discord.of("approvalPrompt").length > 0);
    await b.deliver("o1", null);
    expect(discord.of("sendReply")).toHaveLength(1);
    const { nonce } = discord.of("approvalPrompt")[0]!.arg as { nonce: string };
    expect(b.tools.decide(nonce, "approve", { surface: "discord", userId: OWNER_DISCORD, name: "drk" })).toBe("decided");
    expect(await pending).toEqual({ ok: true, result: "filed" });
    expect(b.registry.pinned).toBe(false);
  });

  test("a web origin still reaches a registered web adapter", async () => {
    const discord = new RecordingAdapter("discord");
    const web = new RecordingAdapter("web");
    const b = boot("discord", [discord, web]);
    await b.deliver("o1", { surface: "web", conversationId: "main" });
    expect(web.of("sendReply")).toHaveLength(1);
    expect(discord.calls).toEqual([]);
  });
});
