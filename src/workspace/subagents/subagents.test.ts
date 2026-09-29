import { describe, expect, test } from "bun:test";
import { RPC_METHODS } from "../../orchestration/contracts.ts";
import { mapTools, parseAgentDef } from "./agentDefs.ts";
import { forkSource, outcomeStatus } from "./host.ts";
import { ChildSlots } from "./slots.ts";
import { MainTurnTracker } from "./turnTracker.ts";

describe("agent defs", () => {
  test("Claude Code frontmatter maps onto Pi tools; aliases and 'inherit' mean the workspace model", () => {
    const def = parseAgentDef(
      "/h/.agents/agents/x.md",
      "---\nname: finder\ndescription: finds things\ntools: Read, Glob, Grep, WebSearch, Bash\ndisallowedTools: Bash\nmodel: haiku\nmaxTurns: 12\n---\nFind it.\n",
    );
    expect(def).toMatchObject({ name: "finder", description: "finds things", tools: ["read", "grep", "find"], maxTurns: 12, writer: false, background: false, prompt: "Find it." });
    expect(def.model).toBeUndefined();
    expect(parseAgentDef("/x/y.md", "---\nmodel: inherit\n---\n").model).toBeUndefined();
    expect(parseAgentDef("/x/y.md", "---\nmodel: openai/gpt-5-mini\n---\n").model).toBe("openai/gpt-5-mini");
  });

  test("no tools key gives the read-only set; a writer has edit or write", () => {
    const def = parseAgentDef("/x/plain.md", "no frontmatter body");
    expect(def).toMatchObject({ name: "plain", tools: ["read", "grep", "find", "ls"], writer: false });
    expect(mapTools(["Edit"])).toEqual(["edit"]);
    expect(parseAgentDef("/x/w.md", "---\ntools: [read, write]\n---\n").writer).toBe(true);
  });

  test("only a writer keeps bash: a read-only def listing Bash loses it", () => {
    expect(parseAgentDef("/x/r.md", "---\ntools: Read, Bash\n---\n")).toMatchObject({ tools: ["read"], writer: false });
    expect(parseAgentDef("/x/c.md", "---\ntools: Read, Bash, Edit\n---\n")).toMatchObject({ tools: ["read", "bash", "edit"], writer: true });
  });
});

describe("ChildSlots", () => {
  test("readers and writers are limited separately and granted FIFO", async () => {
    const slots = new ChildSlots({ reader: 2, writer: 1 });
    const r1 = await slots.acquire("reader");
    await slots.acquire("reader");
    const w1 = await slots.acquire("writer");
    let third = false;
    const pending = slots.acquire("reader").then((r) => {
      third = true;
      return r;
    });
    const w2 = slots.acquire("writer");
    await Promise.resolve();
    expect(third).toBe(false);
    expect(slots.queued("reader")).toBe(1);
    r1();
    await pending;
    expect(third).toBe(true);
    expect(slots.running("reader")).toBe(2);
    w1();
    await w2;
    expect(slots.running("writer")).toBe(1);
  });

  test("an aborted wait leaves the queue", async () => {
    const slots = new ChildSlots({ reader: 1, writer: 1 });
    await slots.acquire("reader");
    const ac = new AbortController();
    const waiting = slots.acquire("reader", ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow("aborted");
    expect(slots.queued("reader")).toBe(0);
  });
});

describe("MainTurnTracker", () => {
  test("tracks the main turn from outgoing chat/events and ignores subagent ones", () => {
    const t = new MainTurnTracker();
    const origin = { surface: "discord", conversationId: "dm" };
    t.observe(RPC_METHODS.chatEvent, { principalId: "p", turnId: "t1", agentId: "main", origin, ev: { type: "turn_start" } });
    t.observe(RPC_METHODS.chatEvent, { principalId: "p", turnId: "t1", agentId: "01RUN", ev: { type: "turn_end", aborted: false } });
    expect(t.current()).toEqual({ turnId: "t1", origin });
    t.observe(RPC_METHODS.chatEvent, { principalId: "p", turnId: "t1", agentId: "main", ev: { type: "turn_end", aborted: false } });
    expect(t.current()).toBeNull();
  });
});

describe("outcomeStatus", () => {
  test("maps record statuses and caps onto run statuses", () => {
    expect(outcomeStatus("completed", null)).toBe("done");
    expect(outcomeStatus("steered", null)).toBe("done");
    expect(outcomeStatus("error", null)).toBe("failed");
    expect(outcomeStatus("stopped", null)).toBe("aborted");
    expect(outcomeStatus("completed", "timeout")).toBe("timeout");
    expect(outcomeStatus("error", "turns")).toBe("aborted");
  });
});

describe("forkSource", () => {
  test("forks from the entry before the message that issued the call", () => {
    const branch = [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "call_9" }] } },
    ];
    const sm = { getSessionFile: () => import.meta.path, getBranch: () => branch };
    expect(forkSource(sm as never, "call_9")).toEqual({ file: import.meta.path, leaf: "u1" });
    expect(() => forkSource(sm as never, "other")).toThrow("not in the parent session");
  });
});
