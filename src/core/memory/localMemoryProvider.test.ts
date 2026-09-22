import { describe, expect, test } from "bun:test";
import type { MemoryEntry, SpaceMemoryStore } from "../contracts.ts";
import type { MemoryScope } from "./banks.ts";
import { createLocalMemoryProvider } from "./localMemoryProvider.ts";

const DM: MemoryScope = { spaceId: "dm", userId: "u1", isPrivate: true };
const DM_BANK = "sushii-dm-u1";
const PUBLIC: MemoryScope = { spaceId: "g1", userId: "u1", isPrivate: false };

function entry(id: number, title: string, content: string): MemoryEntry {
  return { id, title, content, createdAt: 0, updatedAt: 0 };
}

class FakeStore implements SpaceMemoryStore {
  // Hits returned for any bank not present in `byBank`; keeps the simple single-bank tests terse.
  hits: MemoryEntry[] = [];
  byBank: Record<string, MemoryEntry[]> = {};
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
    const hits = this.byBank[spaceId] ?? this.hits;
    return hits.slice(0, limit);
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
  test("retrieve renders a labeled block from hits (DM bank as store key)", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "Prefers TS", "The team prefers TypeScript"), entry(2, "Deploy", "Ship on Fridays")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: DM, query: "typescript", deadlineMs: 600 });

    expect(block).not.toBeNull();
    expect(block).toContain("## Relevant memory");
    expect(block).toContain("- Prefers TS: The team prefers TypeScript");
    expect(block).toContain("- Deploy: Ship on Fridays");
    expect(store.searchCalls[0]).toMatchObject({ spaceId: DM_BANK, query: "typescript" });
  });

  test("public scope reads both banks (individual first) and dedupes by bank:id", async () => {
    const store = new FakeStore();
    store.byBank = {
      "sushii-space-g1-user-u1": [entry(1, "Self", "is a moderator"), entry(2, "Shared", "prefers concise")],
      // Same numeric id (2) under a different bank key must NOT be treated as a duplicate.
      "sushii-space-g1": [entry(2, "Place", "server is about gaming")],
    };
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: PUBLIC, query: "who", deadlineMs: 600 });

    expect(store.searchCalls.map((c) => c.spaceId)).toEqual(["sushii-space-g1-user-u1", "sushii-space-g1"]);
    expect(block).toBe(
      "## Relevant memory\n- Self: is a moderator\n- Shared: prefers concise\n- Place: server is about gaming",
    );
  });

  test("one bank throwing is skipped; the other still injects", async () => {
    const store = new FakeStore();
    const realSearch = store.search.bind(store);
    store.byBank = { "sushii-space-g1": [entry(9, "Place", "the place")] };
    store.search = (spaceId, query, limit) => {
      if (spaceId === "sushii-space-g1-user-u1") throw new Error('fts5: syntax error near "*"');
      return realSearch(spaceId, query, limit);
    };
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: PUBLIC, query: "a * b", deadlineMs: 600 });
    expect(block).toBe("## Relevant memory\n- Place: the place");
  });

  test("empty hits returns null", async () => {
    const store = new FakeStore();
    store.hits = [];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: DM, query: "anything", deadlineMs: 600 });
    expect(block).toBeNull();
  });

  test("blank query returns null without hitting the store", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "x", "y")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: DM, query: "   ", deadlineMs: 600 });
    expect(block).toBeNull();
    expect(store.searchCalls.length).toBe(0);
  });

  test("unscoped (blank userId) returns null without hitting the store", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "x", "y")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: { spaceId: "g1", userId: "  ", isPrivate: false }, query: "x", deadlineMs: 600 });
    expect(block).toBeNull();
    expect(store.searchCalls.length).toBe(0);
  });

  test("expired deadline returns null without hitting the store", async () => {
    const store = new FakeStore();
    store.hits = [entry(1, "x", "y")];
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: DM, query: "x", deadlineMs: 0 });
    expect(block).toBeNull();
    expect(store.searchCalls.length).toBe(0);
  });

  test("respects the item cap (max 6)", async () => {
    const store = new FakeStore();
    store.hits = Array.from({ length: 10 }, (_, i) => entry(i, `t${i}`, `c${i}`));
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: DM, query: "q", deadlineMs: 600 });
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
    const block = await provider.retrieve({ scope: DM, query: "q", deadlineMs: 600, tokenBudget: 20 });
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(20 * 4);
    expect(block).toContain("## Relevant memory");
    // A single oversized item is truncated with an ellipsis rather than dropped.
    expect(block).toContain("…");
  });

  test("retrieve returns null when the only bank's search throws", async () => {
    const store = new FakeStore();
    store.search = () => {
      throw new Error('fts5: syntax error near "*"');
    };
    const provider = createLocalMemoryProvider(store);

    const block = await provider.retrieve({ scope: DM, query: "a * b", deadlineMs: 600 });
    expect(block).toBeNull();
  });

  test("remember upserts the individual bucket with a derived title", async () => {
    const store = new FakeStore();
    const provider = createLocalMemoryProvider(store);

    await provider.remember({ scope: DM, text: "Always deploy on Fridays after the standup meeting" });

    expect(store.upserts.length).toBe(1);
    expect(store.upserts[0].spaceId).toBe(DM_BANK);
    expect(store.upserts[0].content).toBe("Always deploy on Fridays after the standup meeting");
    expect(store.upserts[0].title).toBe("Always deploy on Fridays after the");
  });

  test("remember writes the per-space individual bucket for a public scope", async () => {
    const store = new FakeStore();
    const provider = createLocalMemoryProvider(store);

    await provider.remember({ scope: PUBLIC, text: "a fact" });
    expect(store.upserts.length).toBe(1);
    expect(store.upserts[0].spaceId).toBe("sushii-space-g1-user-u1");
  });

  test("remember ignores blank text and unscoped writes", async () => {
    const store = new FakeStore();
    const provider = createLocalMemoryProvider(store);

    await provider.remember({ scope: DM, text: "   ", importance: 5 });
    expect(store.upserts.length).toBe(0);

    await provider.remember({ scope: { spaceId: "g1", userId: " ", isPrivate: false }, text: "a fact" });
    expect(store.upserts.length).toBe(0);

    await provider.remember({ scope: DM, text: "a fact", importance: 5 });
    expect(store.upserts.length).toBe(1);
    expect(store.upserts[0].title).toBe("a fact");
  });
});
