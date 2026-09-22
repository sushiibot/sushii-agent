import { describe, expect, test } from "bun:test";
import { assembleSystemPrompt } from "./systemPrompt.ts";
import { updateProfileEntry } from "./tools/portable/tools.ts";
import { CORE_PROFILE_TITLE } from "./stores/index.ts";
import type { MemoryEntry, SpaceMemoryStore, ToolContext } from "./contracts.ts";

describe("core profile — system prompt injection", () => {
  test("coreProfile renders an 'About the user' section when present", () => {
    const out = assembleSystemPrompt({ behavior: "b", coreProfile: "Prefers dark mode. Uses Bun." });
    expect(out).toContain("## About the user");
    expect(out).toContain("Prefers dark mode. Uses Bun.");
    expect(out).toContain("update_profile");
  });

  test("no coreProfile → no About-the-user section (parity preserved)", () => {
    const out = assembleSystemPrompt({ behavior: "b" });
    expect(out).not.toContain("## About the user");
  });
});

describe("core profile — update_profile tool", () => {
  function fakeStore(): SpaceMemoryStore & { last?: { spaceId: string; title: string; content: string } } {
    const store = {
      last: undefined as { spaceId: string; title: string; content: string } | undefined,
      getServerContext: () => null,
      setServerContext: () => {},
      listTitles: () => [],
      count: () => 0,
      read: (): MemoryEntry | null => null,
      search: () => [],
      upsert(spaceId: string, title: string, content: string) {
        this.last = { spaceId, title, content };
        return { ok: true as const };
      },
      delete: () => false,
    };
    return store;
  }

  test("writes to the reserved core-profile title", async () => {
    const store = fakeStore();
    const ctx = { space: { surface: "discord" as const, spaceId: "dm" }, memory: store } as unknown as ToolContext;
    const res = await updateProfileEntry.execute({ content: "  Likes TypeScript.  " }, ctx);
    expect(res.content).toBe("Core profile updated.");
    expect(store.last).toEqual({ spaceId: "dm", title: CORE_PROFILE_TITLE, content: "Likes TypeScript." });
  });

  test("blank content is rejected without writing", async () => {
    const store = fakeStore();
    const ctx = { space: { surface: "discord" as const, spaceId: "dm" }, memory: store } as unknown as ToolContext;
    const res = await updateProfileEntry.execute({ content: "   " }, ctx);
    expect(res.content).toContain("requires content");
    expect(store.last).toBeUndefined();
  });
});
