import { describe, expect, test } from "bun:test";
import { createMnemosyneMemoryProvider, type McpToolCall } from "./mnemosyneMemoryProvider.ts";
import type { MemoryScope } from "../banks.ts";

const silentLogger = { debug: () => {}, warn: () => {} };

const DM: MemoryScope = { spaceId: "dm", userId: "u1", isPrivate: true };
const PUBLIC: MemoryScope = { spaceId: "guild-1", userId: "u1", isPrivate: false };

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

function recallHits(rows: { id: string; content: string; score: number }[]) {
  return { status: "ok", count: rows.length, results: rows };
}

describe("mnemosyne retrieve", () => {
  test("maps recall hits → rendered block (content-only lines, DM bank)", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool: McpToolCall = async (name, args) => {
      calls.push({ name, args });
      return recallPayload(["User strongly prefers very concise answers", "Team ships on Fridays"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    const block = await provider.retrieve({ scope: DM, query: "preferences", deadlineMs: 1000 });

    expect(block).toBe(
      "## Relevant memory\n- User strongly prefers very concise answers\n- Team ships on Fridays",
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toBe("mnemosyne_recall");
    expect(calls[0]?.args).toMatchObject({ bank: "sushii-dm-u1", query: "preferences", limit: 6 });
  });

  test("public scope queries BOTH read banks, ranks by score, and keys dedupe per-bank", async () => {
    const banks: string[] = [];
    const callTool: McpToolCall = async (_name, args) => {
      const bank = args["bank"] as string;
      banks.push(bank);
      if (bank === "sushii-space-guild-1-user-u1") {
        // mnemosyne ids are per-bank sequence-like — `m0` here is a DIFFERENT fact than `m0` below.
        return recallHits([
          { id: "m0", content: "is a moderator", score: 0.9 },
          { id: "m1", content: "prefers concise", score: 0.4 },
        ]);
      }
      return recallHits([{ id: "m0", content: "server is about gaming", score: 0.6 }]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    const block = await provider.retrieve({ scope: PUBLIC, query: "who am i", deadlineMs: 1000 });

    expect(banks).toEqual(["sushii-space-guild-1-user-u1", "sushii-space-guild-1"]);
    // Same id `m0` in both banks is kept distinct (keyed by bank:id); ranked by score desc.
    expect(block).toBe(
      "## Relevant memory\n- is a moderator\n- server is about gaming\n- prefers concise",
    );
  });

  test("a cold/malformed bank contributes nothing but the good bank still injects (no warn)", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async (_name, args) => {
      if (args["bank"] === "sushii-space-guild-1-user-u1") {
        return { status: "error", message: "bank missing" }; // cold, not yet created
      }
      return recallPayload(["the place ships on Fridays"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger });

    const block = await provider.retrieve({ scope: PUBLIC, query: "x", deadlineMs: 1000 });
    expect(block).toBe("## Relevant memory\n- the place ships on Fridays");
    expect(warns.length).toBe(0);
  });

  test("empty results → quiet null (no warn)", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => recallPayload([]);
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    expect(await provider.retrieve({ scope: PUBLIC, query: "x", deadlineMs: 1000 })).toBeNull();
    expect(warns.length).toBe(0);
  });

  test("every bank an unexpected shape → null + one warn", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "error", message: "bank missing" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    expect(await provider.retrieve({ scope: PUBLIC, query: "x", deadlineMs: 1000 })).toBeNull();
    expect(warns.length).toBe(1);
  });

  test("results not an array → null + warn", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "ok", results: "nope" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    expect(await provider.retrieve({ scope: DM, query: "x", deadlineMs: 1000 })).toBeNull();
    expect(warns.length).toBe(1);
  });

  test("blank query → null (no call)", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return recallPayload([]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ scope: DM, query: "   ", deadlineMs: 1000 })).toBeNull();
    expect(called).toBe(false);
  });

  test("unscoped (blank userId) → null (no call)", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return recallPayload(["x"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ scope: { spaceId: "g", userId: "  ", isPrivate: false }, query: "x", deadlineMs: 1000 })).toBeNull();
    expect(called).toBe(false);
  });

  test("non-positive deadline → null (no call)", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return recallPayload(["x"]);
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ scope: DM, query: "x", deadlineMs: 0 })).toBeNull();
    expect(called).toBe(false);
  });

  test("slow call resolves to null within deadline", async () => {
    // Seam ignores the abort signal and hangs well past the deadline.
    const callTool: McpToolCall = () => new Promise(() => {});
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    const start = Date.now();
    const result = await provider.retrieve({ scope: DM, query: "x", deadlineMs: 30 });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(500);
  });

  test("a rejected bank → null when it's the only bank", async () => {
    const callTool: McpToolCall = async () => {
      throw new Error("connection refused");
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    expect(await provider.retrieve({ scope: DM, query: "x", deadlineMs: 1000 })).toBeNull();
  });

  test("aborts the underlying requests when the deadline fires", async () => {
    let seenSignal: AbortSignal | undefined;
    const callTool: McpToolCall = (_name, _args, signal) => {
      seenSignal = signal;
      return new Promise(() => {});
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await provider.retrieve({ scope: DM, query: "x", deadlineMs: 20 });
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe("mnemosyne remember", () => {
  test("writes the DM individual bucket (bank/content/importance/global scope)", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool: McpToolCall = async (name, args) => {
      calls.push({ name, args });
      return { status: "stored", memory_id: "m1" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    await provider.remember({ scope: DM, text: "  Deploys are blue/green  ", importance: 0.9 });

    expect(calls[0]?.name).toBe("mnemosyne_remember");
    expect(calls[0]?.args).toEqual({
      bank: "sushii-dm-u1",
      content: "Deploys are blue/green",
      importance: 0.9,
      scope: "global",
    });
  });

  test("public scope writes the per-space individual bucket, defaulting durability to global", async () => {
    const calls: Record<string, unknown>[] = [];
    const callTool: McpToolCall = async (_name, args) => {
      calls.push(args);
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });

    await provider.remember({ scope: PUBLIC, text: "a standing fact" });
    expect(calls[0]).toEqual({ bank: "sushii-space-guild-1-user-u1", content: "a standing fact", scope: "global" });
  });

  test("warns when the server does not store (filtered/error), still returns void", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "filtered", reason: "low signal" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    await expect(provider.remember({ scope: DM, text: "fact" })).resolves.toBeUndefined();
    expect(warns.length).toBe(1);
  });

  test("does not warn on a stored write", async () => {
    const { warns, logger } = capturingLogger();
    const callTool: McpToolCall = async () => ({ status: "stored" });
    const provider = createMnemosyneMemoryProvider({ callTool, logger });
    await provider.remember({ scope: DM, text: "fact" });
    expect(warns.length).toBe(0);
  });

  test("blank text → no call", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await provider.remember({ scope: DM, text: "   " });
    expect(called).toBe(false);
  });

  test("unscoped (blank userId) → no call", async () => {
    let called = false;
    const callTool: McpToolCall = async () => {
      called = true;
      return { status: "stored" };
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await provider.remember({ scope: { spaceId: "g", userId: "  ", isPrivate: false }, text: "fact" });
    expect(called).toBe(false);
  });

  test("swallows errors (never throws)", async () => {
    const callTool: McpToolCall = async () => {
      throw new Error("server down");
    };
    const provider = createMnemosyneMemoryProvider({ callTool, logger: silentLogger });
    await expect(provider.remember({ scope: DM, text: "fact" })).resolves.toBeUndefined();
  });
});
