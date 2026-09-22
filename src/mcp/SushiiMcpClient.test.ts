import { describe, expect, test } from "bun:test";
import { SushiiMcpClient, type SushiiMcpConnection } from "./SushiiMcpClient.ts";

interface Log {
  created: number;
  connects: number;
  closes: number;
}

function textResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fakeConnection(
  log: Log,
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: unknown }>,
): SushiiMcpConnection {
  return {
    connect: async () => {
      log.connects += 1;
    },
    callTool,
    close: async () => {
      log.closes += 1;
    },
  };
}

describe("SushiiMcpClient connection reuse", () => {
  test("connects once and reuses the connection across multiple calls", async () => {
    const log: Log = { created: 0, connects: 0, closes: 0 };
    const client = new SushiiMcpClient("http://x", "tok", {
      createClient: () => {
        log.created += 1;
        return fakeConnection(log, async () => textResult([]));
      },
    });

    await client.getGuildRecentCases({ guild_id: "g" });
    await client.getUserCrossServerBans({ user_id: "u" });
    await client.getUserModHistory({ guild_id: "g", user_id: "u" });

    expect(log.created).toBe(1);
    expect(log.connects).toBe(1);
    expect(log.closes).toBe(0);
  });

  test("a transport failure resets and retries once within the same call, succeeding transparently", async () => {
    const log: Log = { created: 0, connects: 0, closes: 0 };
    let failNext = true;
    const client = new SushiiMcpClient("http://x", "tok", {
      createClient: () => {
        log.created += 1;
        return fakeConnection(log, async () => {
          if (failNext) {
            failNext = false; // a reaped/stale connection: the first attempt fails, the reconnect works
            throw new Error("stream broken");
          }
          return textResult([]);
        });
      },
    });

    // The caller sees success — the reset + reconnect happened inside the one call.
    await expect(client.getGuildRecentCases({ guild_id: "g" })).resolves.toEqual([]);
    expect(log.created).toBe(2);
    expect(log.connects).toBe(2);
    expect(log.closes).toBe(1);
  });

  test("a persistently-down transport fails after a single bounded retry", async () => {
    const log: Log = { created: 0, connects: 0, closes: 0 };
    const client = new SushiiMcpClient("http://x", "tok", {
      createClient: () => {
        log.created += 1;
        return fakeConnection(log, async () => {
          throw new Error("stream broken");
        });
      },
    });

    await expect(client.getGuildRecentCases({ guild_id: "g" })).rejects.toThrow("stream broken");
    // Exactly two attempts (original + one retry), each on a fresh client that was reset/closed.
    expect(log.created).toBe(2);
    expect(log.connects).toBe(2);
    expect(log.closes).toBe(2);
  });

  test("close() shuts the reused connection and is a no-op when never connected", async () => {
    const log: Log = { created: 0, connects: 0, closes: 0 };
    const client = new SushiiMcpClient("http://x", "tok", {
      createClient: () => {
        log.created += 1;
        return fakeConnection(log, async () => textResult([]));
      },
    });

    await client.close(); // never connected — nothing to close
    expect(log.closes).toBe(0);

    await client.getGuildRecentCases({ guild_id: "g" });
    await client.close();
    expect(log.closes).toBe(1);
  });

  test("does not connect until the first call (lazy — unreachable URL can't crash startup)", () => {
    const log: Log = { created: 0, connects: 0, closes: 0 };
    new SushiiMcpClient("http://x", "tok", {
      createClient: () => {
        log.created += 1;
        return fakeConnection(log, async () => textResult([]));
      },
    });

    expect(log.created).toBe(0);
    expect(log.connects).toBe(0);
  });
});
