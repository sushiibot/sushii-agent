import { describe, expect, test } from "bun:test";
import type { ChatMessageParams } from "../contracts.ts";
import { RpcErrorReply, RpcTimeoutError } from "../transport/server.ts";
import { handleOwnerMessage, REJECTED_ERROR_MAX, type OwnerRouterDeps } from "./router.ts";
import type { AckKind, InboundMessage, InboundSurface, RouterNotice, SurfaceActor } from "./surface.ts";

const ORIGIN = { surface: "web", conversationId: "main" };

function message(text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return { origin: ORIGIN, id: "01J0000000000000000000000", text, author: { id: "owner@github", name: "drk" }, isVoice: false, attachments: [], ...extra };
}

function harness(opts: { connected?: boolean; enabled?: boolean; sendError?: Error; isOwner?: (a: SurfaceActor) => boolean } = {}) {
  const calls = {
    acks: [] as AckKind[],
    notices: [] as RouterNotice[],
    fallback: 0,
    resets: 0,
    offline: 0,
    sent: [] as Array<Omit<ChatMessageParams, "principalId">>,
    owners: [] as SurfaceActor[],
    logins: 0,
  };
  const surface: InboundSurface = {
    ack: async (_m, kind) => void calls.acks.push(kind),
    notice: async (_m, n) => void calls.notices.push(n),
    transcribe: async () => null,
    fallbackReply: async () => {
      calls.fallback++;
      return "fallback";
    },
    resetFallback: async () => {
      calls.resets++;
    },
  };
  const deps: OwnerRouterDeps<InboundMessage> = {
    workspaceEnabled: opts.enabled ?? true,
    transcriptionEnabled: false,
    offline: "reject",
    surface,
    cursor: { advance: () => {} },
    link: {
      isConnected: () => opts.connected ?? true,
      sendMessage: async (input) => {
        calls.sent.push(input);
        if (opts.sendError) throw opts.sendError;
        return { accepted: true, mode: "prompt" };
      },
      abort: async () => ({ aborted: true }),
      newSession: async () => ({ sessionFile: "s" }),
      recordOffline: () => {
        calls.offline++;
      },
      isOwner: (a) => {
        calls.owners.push(a);
        return opts.isOwner?.(a) ?? false;
      },
      isLoginPending: () => false,
      startLogin: async () => {
        calls.logins++;
        return { status: "started" };
      },
      completeLogin: async () => ({ status: "ok" }),
      cancelLogin: async () => ({ status: "cancelled" }),
    },
  };
  return { deps, calls };
}

describe("router offline: reject", () => {
  test("workspace offline: one workspaceOffline notice, no receipt, no fallback, nothing recorded", async () => {
    const { deps, calls } = harness({ connected: false });
    await handleOwnerMessage(message("hi"), deps);
    expect(calls.notices).toEqual([{ type: "workspaceOffline" }]);
    expect(calls.acks).toEqual([]);
    expect(calls.fallback).toBe(0);
    expect(calls.offline).toBe(0);
    expect(calls.sent).toEqual([]);
  });

  test("chat/message refused while connected: messageRejected with the error, never workspaceOffline", async () => {
    const { deps, calls } = harness({ sendError: new RpcErrorReply("busy", -32000) });
    await handleOwnerMessage(message("hi"), deps);
    expect(calls.sent).toHaveLength(1);
    expect(calls.notices).toEqual([{ type: "messageRejected", error: "busy" }]);
    expect(calls.acks).toEqual([]);
    expect(calls.fallback).toBe(0);
    expect(calls.offline).toBe(0);
  });

  test("a refusal's error text is capped", async () => {
    const { deps, calls } = harness({ sendError: new RpcErrorReply("x".repeat(5_000), -32000) });
    await handleOwnerMessage(message("hi"), deps);
    const n = calls.notices[0] as { type: string; error: string };
    expect(n.type).toBe("messageRejected");
    expect(n.error).toHaveLength(REJECTED_ERROR_MAX);
    expect(n.error.endsWith("…")).toBe(true);
  });

  test("a send that fails because the link dropped is workspaceOffline", async () => {
    const { deps, calls } = harness({ sendError: new Error("gone") });
    let connected = true;
    deps.link.isConnected = () => connected;
    const send = deps.link.sendMessage;
    deps.link.sendMessage = async (input) => {
      connected = false;
      return send(input);
    };
    await handleOwnerMessage(message("hi"), deps);
    expect(calls.notices).toEqual([{ type: "workspaceOffline" }]);
    expect(calls.acks).toEqual([]);
  });

  test("an unconfirmed send while connected is still left to the workspace as queued", async () => {
    const { deps, calls } = harness({ sendError: new RpcTimeoutError("timeout") });
    await handleOwnerMessage(message("hi"), deps);
    expect(calls.acks).toEqual(["queued"]);
    expect(calls.notices).toEqual([]);
  });

  test("workspace disabled: messages and !new are rejected, never answered in-process", async () => {
    const { deps, calls } = harness({ enabled: false });
    await handleOwnerMessage(message("hi"), deps);
    await handleOwnerMessage(message("!new"), deps);
    expect(calls.notices).toEqual([{ type: "workspaceOffline" }, { type: "workspaceOffline" }]);
    expect(calls.resets).toBe(0);
    expect(calls.fallback).toBe(0);
    expect(calls.offline).toBe(0);
  });

  test("connected: the message goes to the workspace as usual", async () => {
    const { deps, calls } = harness();
    await handleOwnerMessage(message("hi"), deps);
    expect(calls.sent.map((m) => m.text)).toEqual(["hi"]);
    expect(calls.acks).toEqual(["accepted"]);
    expect(calls.notices).toEqual([]);
  });

  test("the fallback mode is unchanged: offline answers in-process and records the exchange", async () => {
    const { deps, calls } = harness({ connected: false });
    await handleOwnerMessage(message("hi"), { ...deps, offline: "fallback" });
    expect(calls.acks).toEqual(["accepted"]);
    expect(calls.fallback).toBe(1);
    expect(calls.offline).toBe(1);
  });
});

describe("router owner identity", () => {
  test("the owner check gets the surface's verified actor when the message carries one", async () => {
    const verified: SurfaceActor = Object.freeze({ surface: "web", userId: "owner@github", name: "drk" });
    const { deps, calls } = harness({ isOwner: (a) => a === verified });
    await handleOwnerMessage(message("!login chatgpt", { actor: verified }), deps);
    expect(calls.owners[0]).toBe(verified);
    expect(calls.logins).toBe(1);
  });

  test("without one, a plain actor is built from the message and a strict check refuses it", async () => {
    const { deps, calls } = harness({ isOwner: () => false });
    await handleOwnerMessage(message("!login chatgpt"), deps);
    expect(calls.owners[0]).toEqual({ surface: "web", userId: "owner@github", name: "drk" });
    expect(calls.logins).toBe(0);
  });
});
