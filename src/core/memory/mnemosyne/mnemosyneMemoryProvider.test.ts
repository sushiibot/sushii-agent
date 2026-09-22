import { describe, expect, test } from "bun:test";
import { createMnemosyneMemoryProvider, type McpToolCall } from "./mnemosyneMemoryProvider.ts";

const silentLogger = { debug: () => {}, warn: () => {} };

function capturingLogger() {
  const warns: unknown[][] = [];
  return {
    warns,
    logger: { debug: () => {}, warn: (...a: unknown[]) => warns.push(a) },
  };
}

function recallPayload(contents: string[]) {
  return {
    status: "ok",
    count: contents.length,
    results: contents.map((content, i) => ({ id: `m${i}`, content, importance: 0.5, score: 1 - i * 0.1 })),
  };
}

describe("mnemosyne retrieve", () => {
  test("maps recall hits → rendered block (content-only lines, namespaced bank)", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool: McpToolCall = async (name, args) => {
      calls.push({ name, args });
      return recallPayload(["User strongly prefers very concise answers", "Team ships on Fridays"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    const block = await provider.retrieve({ spaceId: "guild-1", query: "preferences", deadlineMs: 1000 });

    expect(block).toBe(
      "## Relevant memory\n- User strongly prefers very concise answers\n- Team ships on Fridays",
    );
    expect(calls[0]?.name).toBe("mnemosyne_recall");
    expect(calls[0]?.args).toMatchObject({ bank: "sushii-guild-1", query: "preferences", limit: 6 });
  });

  test("empty results → quiet null (no warn)", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => recallPayload([]);
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    expect(await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 1000 })).toBeNull();
    expect(warns.length).toBe(0);
  });

  test("unexpected recall shape → null + warn", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "error", message: "bank missing" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    expect(await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 1000 })).toBeNull();
    expect(warns.length).toBe(1);
  });

  test("results not an array → null + warn", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "ok", results: "nope" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    expect(await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 1000 })).toBeNull();
    expect(warns.length).toBe(1);
  });

  test("blank query → null (no call)", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return recallPayload([]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ spaceId: "g", query: "   ", deadlineMs: 1000 })).toBeNull();
    expect(called).toBe(false);
  });

  test("blank spaceId → null (no call)", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return recallPayload(["x"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ spaceId: "   ", query: "x", deadlineMs: 1000 })).toBeNull();
    expect(called).toBe(false);
  });

  test("non-positive deadline → null (no call)", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return recallPayload(["x"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 0 })).toBeNull();
    expect(called).toBe(false);
  });

  test("slow call resolves to null within deadline", async () => {
    // Seam ignores the abort signal and hangs well past the deadline.
    const callTool: McpToolCall = () => new Promise(() => {});
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    const start = Date.now();
    const result = await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 30 });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(500);
  });

  test("erroring call → null", async () => {
    const callTool: McpToolCall = async () => {
      throw new Error("connection refused");
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 1000 })).toBeNull();
  });

  test("aborts the underlying request when the deadline fires", async () => {
    let seenSignal: AbortSignal | undefined;
    const callTool: McpToolCall = (_name, _args, signal) => {
      seenSignal = signal;
      return new Promise(() => {});
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await provider.retrieve({ spaceId: "g", query: "x", deadlineMs: 20 });
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe("mnemosyne remember", () => {
  test("maps args to mnemosyne_remember (namespaced bank/content/importance/scope/valid_until)", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool: McpToolCall = async (name, args) => {
      calls.push({ name, args });
      return { status: "stored", memory_id: "m1" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    await provider.remember({
      spaceId: "guild-9",
      text: "  Deploys are blue/green  ",
      importance: 0.9,
      scope: "global",
      validUntil: Date.UTC(2026, 0, 15),
    });

    expect(calls[0]?.name).toBe("mnemosyne_remember");
    expect(calls[0]?.args).toEqual({
      bank: "sushii-guild-9",
      content: "Deploys are blue/green",
      importance: 0.9,
      scope: "global",
      valid_until: "2026-01-15",
    });
  });

  test("defaults scope to global and namespaces the bank when only text is provided", async () => {
    const calls: Record<string, unknown>[] = [];
    const callTool: McpToolCall = async (_name, args) => {
      calls.push(args);
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    await provider.remember({ spaceId: "g", text: "a standing fact" });
    expect(calls[0]).toEqual({ bank: "sushii-g", content: "a standing fact", scope: "global" });
  });

  test("passes through an explicit session scope", async () => {
    const calls: Record<string, unknown>[] = [];
    const callTool: McpToolCall = async (_name, args) => {
      calls.push(args);
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    await provider.remember({ spaceId: "g", text: "ephemeral", scope: "session" });
    expect(calls[0]).toMatchObject({ scope: "session" });
  });

  test("warns when the server does not store (filtered/error), still returns void", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "filtered", reason: "low signal" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    await expect(provider.remember({ spaceId: "g", text: "fact" })).resolves.toBeUndefined();
    expect(warns.length).toBe(1);
  });

  test("does not warn on a stored write", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "stored" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    await provider.remember({ spaceId: "g", text: "fact" });
    expect(warns.length).toBe(0);
  });

  test("blank text → no call", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await provider.remember({ spaceId: "g", text: "   " });
    expect(called).toBe(false);
  });

  test("blank spaceId → no call", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await provider.remember({ spaceId: "  ", text: "fact" });
    expect(called).toBe(false);
  });

  test("an out-of-range validUntil never throws out of remember", async () => {
    const calls: Record<string, unknown>[] = [];
    const callTool: McpToolCall = async (_name, args) => {
      calls.push(args);
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    // A wild epoch that makes `new Date(...).toISOString()` throw RangeError.
    await expect(
      provider.remember({ spaceId: "g", text: "fact", validUntil: 1e21 }),
    ).resolves.toBeUndefined();
    // Bad date is skipped, not sent.
    expect(calls[0]).not.toHaveProperty("valid_until");
  });

  test("swallows errors (never throws)", async () => {
    const callTool: McpToolCall = async () => {
      throw new Error("server down");
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await expect(provider.remember({ spaceId: "g", text: "fact" })).resolves.toBeUndefined();
  });
});
