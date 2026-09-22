import { describe, expect, test } from "bun:test";
import type { MemoryEntry, SpaceMemoryStore } from "../contracts.ts";
import { createLocalMemoryProvider } from "./localMemoryProvider.ts";

function entry(id: number, title: string, content: string): MemoryEntry {
  return { id, title, content, createdAt: 0, updatedAt: 0 };
}

class FakeStore implements SpaceMemoryStore {
  hits: MemoryEntry[] = [];
  searchCalls: { spaceId: string; query: string; limit?: number }[] = [];
  upserts: { spaceId: string; title: string; content: string }[] = [];

  getServerContext(): string | null {
    return null;
  }
  setServerContext(): void {}
  listTitles(): string[] {
    return [];
  }
  count(): number {
    return 0;
  }
  read(): MemoryEntry | null {
    return null;
  }
  search(spaceId: string, query: string, limit?: number): MemoryEntry[] {
    this.searchCalls.push({ spaceId, query, limit });
    return this.hits.slice(0, limit);
  }
  upsert(spaceId: string, title: string, content: string): { ok: true } | { error: string } {
    this.upserts.push({ spaceId, title, content });
    return { ok: true };
  }
  delete(): boolean {
    return false;
  }
}

describe("createLocalMemoryProvider", () => {
  test("retrieve renders a labeled block from hits", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "Prefers TS", "The team prefers TypeScript"), entry(2, "Deploy", "Ship on Fridays")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ spaceId: "g1", query: "typescript", deadlineMs: 600 });

    expect(block).not.toBeNull();
    expect(block).toContain("## Relevant memory");
    expect(block).toContain("- Prefers TS: The team prefers TypeScript");
    expect(block).toContain("- Deploy: Ship on Fridays");
    expect(store.searchCalls[0]).toMatchObject({ spaceId: "g1", query: "typescript" });
  });

  test("empty hits returns null", async () => {
    const store = new FakeStore();
    store.hits = [];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ spaceId: "g1", query: "anything", deadlineMs: 600 });
    expect(block).toBeNull();
  });

  test("blank query returns null without hitting the store", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "x", "y")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ spaceId: "g1", query: "   ", deadlineMs: 600 });
    expect(block).toBeNull();
    expect(store.searchCalls.length).toBe(0);
  });

  test("expired deadline returns null without hitting the store", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "x", "y")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ spaceId: "g1", query: "x", deadlineMs: 0 });
    expect(block).toBeNull();
    expect(store.searchCalls.length).toBe(0);
  });

  test("respects the item cap (max 6)", async () => {
    const store = new FakeStore();
    store.hits = Array.from({ length: 10 }, (_, i) => entry(i, `t${i}`, `c${i}`));
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ spaceId: "g1", query: "q", deadlineMs: 600 });
    const itemLines = block!.split("\n").filter((l) => l.startsWith("- "));
    expect(itemLines.length).toBe(6);
    expect(store.searchCalls[0].limit).toBe(6);
  });

  test("respects the token budget, truncating the rendered block", async () => {
    const store = new FakeStore();
    const big = "x".repeat(2000);
    store.hits = Array.from({ length: 6 }, (_, i) => entry(i, `t${i}`, big));
    const provider = createLocalMemoryProvider(store);

    // 20 tokens ≈ 80 chars — far smaller than the raw hits.
    const block = await provider.retrieve({ spaceId: "g1", query: "q", deadlineMs: 600, tokenBudget: 20 });
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(20 * 4);
    expect(block).toContain("## Relevant memory");
    // A single oversized item is truncated with an ellipsis rather than dropped.
    expect(block).toContain("…");
  });

  test("remember upserts with a derived title", async () => {
    const store = new FakeStore();
    const provider = createLocalMemoryProvider(store);

    await provider.remember({ spaceId: "g1", text: "Always deploy on Fridays after the standup meeting" });

    expect(store.upserts.length).toBe(1);
    expect(store.upserts[0].spaceId).toBe("g1");
    expect(store.upserts[0].content).toBe("Always deploy on Fridays after the standup meeting");
    expect(store.upserts[0].title).toBe("Always deploy on Fridays after the");
  });

  test("remember ignores extra fields and blank text", async () => {
    const store = new FakeStore();
    const provider = createLocalMemoryProvider(store);

    await provider.remember({ spaceId: "g1", text: "   ", importance: 5, scope: "global", validUntil: 123 });
    expect(store.upserts.length).toBe(0);

    await provider.remember({ spaceId: "g1", text: "a fact", importance: 5, scope: "session", validUntil: 999 });
    expect(store.upserts.length).toBe(1);
    expect(store.upserts[0].title).toBe("a fact");
  });
});
