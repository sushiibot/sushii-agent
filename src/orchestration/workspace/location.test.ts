import { describe, expect, test } from "bun:test";
import type { ConnectionInfo } from "../transport/server.ts";
import type { ApprovalDecision, ApprovalView } from "./surface.ts";
import { isVerifiedWebActor, mintWebActor } from "../../surfaces/web/actor.ts";
import { BrowserLocationRequests, locationReply } from "./location.ts";

const conn = { principalId: "owner" } as ConnectionInfo;
const params = { principalId: "owner", callId: "call1", name: "request_current_location", agentId: "main", agentName: "main", args: { reason: "Find nearby coffee" } };
const now = 1_800_000_000_000;
const shared = { status: "shared", latitude: 35.123456, longitude: -120.654321, accuracy: 12, timestamp: now };
function setup(timeoutMs = 1000) {
  let nonce = "";
  const decisions: ApprovalDecision[] = [];
  const views: ApprovalView[] = [];
  const requests = new BrowserLocationRequests({ now: () => now, timeoutMs,
    isOwner: (a) => isVerifiedWebActor(a) && a.userId === "owner@example.com",
    prompt: async (view, n) => { nonce = n; views.push(view); return { id: n }; },
    resolved: async (_h, _v, _n, d) => { decisions.push(d); },
  });
  return { requests, decisions, views, nonce: () => nonce };
}
const owner = () => mintWebActor("owner@example.com");

describe("browser location request", () => {
  test("one owner reply resolves precisely its call, no coordinates in approval history", async () => {
    const h = setup();
    const result = h.requests.request(conn, params);
    await Promise.resolve();
    expect(h.requests.fulfill(h.nonce(), shared, { surface: "web", userId: "owner@example.com", name: "spoof" })).toBe("forbidden");
    expect(h.requests.fulfill(h.nonce(), shared, mintWebActor("other@example.com"))).toBe("forbidden");
    expect(h.requests.fulfill("wrong-nonce", shared, owner())).toBe("expired");
    expect(h.requests.fulfill(h.nonce(), shared, owner())).toBe("decided");
    const r = await result;
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.result)).toMatchObject(shared);
    expect(h.requests.fulfill(h.nonce(), shared, owner())).toBe("expired");
    expect(h.decisions).toEqual(["approve"]);
    expect(JSON.stringify(h.views)).not.toContain(String(shared.latitude));
  });
  test("threads, subagents and other surfaces still require explicit owner sharing", async () => {
    for (const origin of [{ surface: "web" as const, conversationId: "trip" }, { surface: "discord" as const, conversationId: "channel", guildId: "guild" }, undefined]) {
      const h = setup();
      const result = h.requests.request(conn, { ...params, agentId: "subagent", parentRunId: "parent", origin });
      expect(h.views).toHaveLength(1);
      expect(h.views[0]!.fields).toContainEqual({ key: "conversation", value: origin?.conversationId ?? "main", kind: "body" });
      expect(h.requests.has(h.nonce())).toBe(true);
      expect(h.requests.fulfill(h.nonce(), shared, owner())).toBe("decided");
      expect((await result).ok).toBe(true);
    }
  });
  test("bounds, finite numbers, freshness, closed payloads", async () => {
    const h = setup();
    const result = h.requests.request(conn, params);
    for (const bad of [{ ...shared, latitude: 91 }, { ...shared, longitude: -181 }, { ...shared, accuracy: -1 }, { ...shared, latitude: Infinity }, { ...shared, timestamp: now - 120001 }, { ...shared, timestamp: now + 30001 }, { ...shared, principalId: "other" }]) {
      expect(h.requests.fulfill(h.nonce(), bad, owner())).toBe("invalid");
    }
    expect(h.requests.fulfill(h.nonce(), { status: "denied" }, owner())).toBe("decided");
    expect(await result).toMatchObject({ ok: false, denied: true });
  });
  test("request schema and pending cap", async () => {
    const h = setup();
    expect(await h.requests.request(conn, { ...params, args: { reason: "x", latitude: 1 } })).toMatchObject({ ok: false });
    expect(h.views).toHaveLength(0);
    const result = h.requests.request(conn, params);
    expect(await h.requests.request(conn, { ...params, callId: "call2" })).toMatchObject({ ok: false });
    expect(h.requests.cancel({ ...conn }, params.callId)).toBe(false);
    expect(h.requests.cancel(conn, "call2")).toBe(false);
    expect(h.requests.cancel(conn, params.callId)).toBe(true);
    expect(await result).toMatchObject({ ok: false, error: "location request cancelled" });
  });
  test("missing client and hung prompt cannot block forever", async () => {
    const h = setup(5);
    expect(await h.requests.request(conn, params)).toMatchObject({ ok: false });
    expect(h.decisions).toEqual(["timeout"]);
    const hung = new BrowserLocationRequests({ isOwner: () => true, timeoutMs: 5, prompt: () => new Promise(() => {}), resolved: async () => {} });
    expect(await hung.request(conn, params)).toMatchObject({ ok: false });
  });
  test("all browser error statuses settle, never accept arbitrary text", async () => {
    for (const status of ["unsupported", "timeout", "unavailable", "cancelled"]) {
      const h = setup();
      const result = h.requests.request(conn, params);
      expect(h.requests.fulfill(h.nonce(), { status }, owner())).toBe("decided");
      expect(await result).toMatchObject({ ok: false });
    }
    expect(locationReply.safeParse({ status: "denied", message: "secret" }).success).toBe(false);
  });
});
