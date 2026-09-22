import { describe, expect, test } from "bun:test";
import { createMnemosyneCallTool, type MnemosyneClient } from "./mnemosyneClient.ts";

interface FakeSpec {
  connect?: () => Promise<void>;
  callTool?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

function fakeClient(spec: FakeSpec, log: { closes: number }): MnemosyneClient {
  return {
    connect: spec.connect ?? (() => Promise.resolve()),
    callTool: spec.callTool ?? (async () => ({ status: "ok" })),
    close: async () => {
      log.closes += 1;
    },
  };
}

describe("mnemosyne client seam", () => {
  test("a caller abort does NOT tear down the connection", async () => {
    const closes = { closes: 0 };
    let created = 0;
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });

    const callTool = createMnemosyneCallTool({
      url: "http://x",
      createClient: () => {
        created += 1;
        return fakeClient(
          {
            callTool: async () => {
              throw abortErr;
            },
          },
          closes,
        );
      },
    });

    await expect(callTool("mnemosyne_recall", {}, AbortSignal.abort())).rejects.toThrow("aborted");
    // A following call reuses the same (healthy) client — no reconnect, no close.
    await callTool("mnemosyne_recall", {}).catch(() => {});

    expect(created).toBe(1);
    expect(closes.closes).toBe(0);
  });

  test("a genuine transport error resets the connection (reconnect + close)", async () => {
    const closes = { closes: 0 };
    let created = 0;

    const callTool = createMnemosyneCallTool({
      url: "http://x",
      createClient: () => {
        created += 1;
        return fakeClient(
          {
            callTool: async () => {
              throw new Error("stream broken");
            },
          },
          closes,
        );
      },
    });

    await expect(callTool("mnemosyne_recall", {})).rejects.toThrow("stream broken");
    await callTool("mnemosyne_recall", {}).catch(() => {});

    // Each transport failure resets: two calls → two fresh clients, each closed on its reset.
    expect(created).toBe(2);
    expect(closes.closes).toBe(2);
  });

  test("a hung connect rejects on the timeout and a later call recovers", async () => {
    const closes = { closes: 0 };
    let created = 0;

    const callTool = createMnemosyneCallTool({
      url: "http://x",
      connectTimeoutMs: 20,
      createClient: () => {
        created += 1;
        if (created === 1) {
          return fakeClient({ connect: () => new Promise(() => {}) }, closes);
        }
        return fakeClient({ callTool: async () => ({ status: "ok", results: [] }) }, closes);
      },
    });

    await expect(callTool("mnemosyne_recall", {})).rejects.toThrow(/timed out/);
    // Cached promise was nulled on the failed connect, so the next call builds a fresh client.
    const result = await callTool("mnemosyne_recall", {});

    expect(result).toEqual({ status: "ok", results: [] });
    expect(created).toBe(2);
  });
});
