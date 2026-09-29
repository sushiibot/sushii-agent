import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { bashChangedRepo, createVerifyGateExtension, explainsNoCheck, isCheckCommand, VERIFY_CUSTOM_TYPE } from "./verifyGate.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "verify-gate-"));
  mkdirSync(join(home, "projects", "app", "src"), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness() {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as ExtensionAPI;
  void createVerifyGateExtension({ home, cwd: home })(pi);
  return {
    start: (prompt = "fix the bug") => handlers.get("before_agent_start")!({ type: "before_agent_start", prompt }),
    result: (toolName: string, input: Record<string, unknown>, isError = false) =>
      handlers.get("tool_result")!({ type: "tool_result", toolName, input, isError, content: [] }),
    settle: (outcome = "completed", finalText = "done") =>
      handlers.get("agent_before_settle")!({
        type: "agent_before_settle",
        outcome,
        continue: false,
        entries: [{ type: "custom", customType: "earlier" }],
        context: { contextEntries: [], contextMessages: [{ role: "assistant", content: [{ type: "text", text: finalText }] }] },
      }) as { entries: Array<{ type: string; customType: string; content: string }>; continue: boolean } | undefined,
  };
}

const editApp = { path: "projects/app/src/a.ts", edits: [{ oldText: "a", newText: "b" }] };

describe("verify gate", () => {
  test("a code change without a check gets one follow-up, keeping earlier boundary entries", () => {
    const h = harness();
    h.start();
    h.result("edit", editApp);
    const out = h.settle();
    expect(out?.continue).toBe(true);
    expect(out?.entries[0]).toEqual({ type: "custom", customType: "earlier" } as never);
    expect(out?.entries[1]).toMatchObject({ type: "custom_message", customType: VERIFY_CUSTOM_TYPE, display: false });
    expect(out?.entries[1].content).toContain("projects/app");
  });

  test("once per run: the settle after the follow-up passes even without a check", () => {
    const h = harness();
    h.start();
    h.result("write", { path: join(home, "projects/app/src/b.ts"), content: "x" });
    expect(h.settle()?.continue).toBe(true);
    expect(h.settle()).toBeUndefined();
  });

  test("resets per run", () => {
    const h = harness();
    h.start();
    h.result("edit", editApp);
    expect(h.settle()?.continue).toBe(true);
    h.start();
    expect(h.settle()).toBeUndefined();
    h.result("edit", editApp);
    expect(h.settle()?.continue).toBe(true);
  });

  test("a code change followed by a check, even a failing one, gets none", () => {
    const h = harness();
    h.start();
    h.result("edit", editApp);
    h.result("bash", { command: "cd projects/app && bun test" }, true);
    expect(h.settle()).toBeUndefined();
  });

  test("a change after the last check still needs one", () => {
    const h = harness();
    h.start();
    h.result("bash", { command: "cd projects/app && bunx tsc --noEmit" });
    h.result("edit", editApp);
    expect(h.settle()?.continue).toBe(true);
  });

  test("no code change gets none: memory writes, reads, failed edits, git commit", () => {
    const h = harness();
    h.start();
    h.result("write", { path: "MEMORY.md", content: "x" });
    h.result("read", { path: "projects/app/src/a.ts" });
    h.result("edit", editApp, true);
    h.result("bash", { command: "cd projects/app && git add -A && git commit -m 'x' && git push" });
    expect(h.settle()).toBeUndefined();
  });

  test("aborted and errored runs get none", () => {
    const h = harness();
    h.start();
    h.result("edit", editApp);
    expect(h.settle("aborted")).toBeUndefined();
    expect(h.settle("error")).toBeUndefined();
  });

  test("hidden memory-flush runs get none", () => {
    const h = harness();
    h.start(`${FLUSH_MARKER} The session is about to reset.`);
    h.result("edit", editApp);
    expect(h.settle()).toBeUndefined();
  });

  test("a final reply explaining why the check can't run gets none", () => {
    const h = harness();
    h.start();
    h.result("edit", editApp);
    expect(h.settle("completed", "Done. I can't run the tests here because the database isn't available.")).toBeUndefined();
  });

  test("a bash change to a project counts", () => {
    const h = harness();
    h.start();
    h.result("bash", { command: "sed -i 's/a/b/' projects/app/src/a.ts" });
    expect(h.settle()?.entries.at(-1)?.content).toContain("projects/app");
  });
});

describe("command matching", () => {
  test("check commands", () => {
    for (const c of [
      "bun test",
      "cd projects/app && DISCORD_BOT_TOKEN=x bun test src/a.test.ts",
      "bunx tsc --noEmit",
      "npm run lint",
      "npm run test:unit",
      "uv run pytest -q",
      "cargo test",
      "go test ./...",
      "make",
      "timeout 120 bun test 2>&1 | tail",
    ]) {
      expect(isCheckCommand(c)).toBe(true);
    }
    for (const c of ["git checkout main", "cat src/a.test.ts", "ls tests", "echo latest", "git log", "test -f package.json", "bun run build"]) {
      expect(isCheckCommand(c)).toBe(false);
    }
  });

  test("bash changes to a repo", () => {
    expect(bashChangedRepo("echo x > projects/app/a.txt")).toBe("app");
    expect(bashChangedRepo("cd projects/app && git apply /tmp/p.diff")).toBe("app");
    expect(bashChangedRepo("rm projects/app/old.ts")).toBe("app");
    expect(bashChangedRepo("cd projects/app && git commit -am x")).toBeNull();
    expect(bashChangedRepo("cd projects/app && bun test 2>&1 >/dev/null")).toBeNull();
    expect(bashChangedRepo("echo x > notes.txt")).toBeNull();
  });

  test("explaining a missing check", () => {
    expect(explainsNoCheck("I couldn't run the typecheck: tsc isn't installed.")).toBe(true);
    expect(explainsNoCheck("There are no tests configured in this repo.")).toBe(true);
    expect(explainsNoCheck("Fixed the bug.")).toBe(false);
  });
});
