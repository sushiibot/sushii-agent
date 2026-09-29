import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMemoryWrite, containsSecret, createMemoryGuardExtension } from "./memoryGuard.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ws-memguard-"));
  mkdirSync(join(home, "memory"));
  writeFileSync(join(home, "USER.md"), "# USER\n- Likes tea. (src: 2026-09-29, discord:1)\n");
  writeFileSync(join(home, "MEMORY.md"), "# MEMORY\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const opts = () => ({ home, cwd: home });
const edit = (path: string, oldText: string, newText: string) => ({ path, edits: [{ oldText, newText }] });

describe("containsSecret", () => {
  test("flags tokens, keys and JWTs; passes ordinary notes", () => {
    expect(containsSecret("key sk-abcdefghijklmnopqrstuv")).toBe(true);
    expect(containsSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(containsSecret("Authorization: Bearer abc.def")).toBe(true);
    expect(containsSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")).toBe(true);
    expect(containsSecret("- Prefers metric units. (src: 2026-09-29, discord:1234567890123456789)")).toBe(false);
    expect(containsSecret("deployed a90c7902b4e1 to prod")).toBe(false);
  });
});

describe("checkMemoryWrite", () => {
  test("allows a normal edit and write to memory files", () => {
    expect(checkMemoryWrite("edit", edit("USER.md", "- Likes tea.", "- Likes green tea."), opts())).toBeNull();
    expect(checkMemoryWrite("write", { path: "memory/2026-09-29.md", content: "- met Sam\n" }, opts())).toBeNull();
    expect(checkMemoryWrite("write", { path: join(home, "MEMORY.md"), content: "# MEMORY\n- x\n" }, opts())).toBeNull();
  });

  test("blocks a secret in an edit, a write and a bash redirect into memory", () => {
    expect(checkMemoryWrite("edit", edit("MEMORY.md", "# MEMORY\n", "# MEMORY\n- api key sk-abcdefghijklmnopqrstuv\n"), opts())).toBe("secret");
    expect(checkMemoryWrite("write", { path: "memory/2026-09-29.md", content: "token ghp_abcdefghijklmnopqrstuvwxyz0123" }, opts())).toBe("secret");
    expect(checkMemoryWrite("bash", { command: "echo 'sk-abcdefghijklmnopqrstuv' >> ~/MEMORY.md" }, opts())).toBe("secret");
    expect(checkMemoryWrite("bash", { command: "echo 'sk-abcdefghijklmnopqrstuv' | tee -a memory/today.md" }, opts())).toBe("secret");
  });

  test("scans only the added text, so an existing secret can be edited out", () => {
    const existing = "- old sk-abcdefghijklmnopqrstuv";
    writeFileSync(join(home, "MEMORY.md"), `# MEMORY\n${existing}\n`);
    expect(checkMemoryWrite("edit", edit("MEMORY.md", existing, "- old (removed)"), opts())).toBeNull();
  });

  test("ignores writes elsewhere", () => {
    expect(checkMemoryWrite("write", { path: "scratch/x.md", content: "sk-abcdefghijklmnopqrstuv" }, opts())).toBeNull();
    expect(checkMemoryWrite("bash", { command: "echo sk-abcdefghijklmnopqrstuv > scratch/x" }, opts())).toBeNull();
  });

  test("blocks growth past the USER.md and MEMORY.md caps, but allows shrinking an over-cap file", () => {
    expect(checkMemoryWrite("write", { path: "USER.md", content: "x".repeat(4001) }, opts())).toBe("cap:USER.md:4000:4001");
    const big = "y".repeat(7990);
    writeFileSync(join(home, "MEMORY.md"), big);
    expect(checkMemoryWrite("edit", edit("MEMORY.md", "yyyy", "yyyy and then some more"), opts())).toMatch(/^cap:MEMORY\.md:8000:/);
    writeFileSync(join(home, "MEMORY.md"), "z".repeat(9000));
    expect(checkMemoryWrite("edit", edit("MEMORY.md", "zzzzzzzzzz", "z"), opts())).toBeNull();
    expect(checkMemoryWrite("write", { path: "MEMORY.md", content: "z".repeat(8500) }, opts())).toBeNull();
    // Daily notes have no cap.
    expect(checkMemoryWrite("write", { path: "memory/2026-09-29.md", content: "n".repeat(20_000) }, opts())).toBeNull();
  });
});

describe("createMemoryGuardExtension", () => {
  test("returns a block with a reason and logs no content", () => {
    const warns: object[] = [];
    let handler: ((e: unknown) => unknown) | undefined;
    const pi = { on: (_: string, h: (e: unknown) => unknown) => (handler = h) };
    createMemoryGuardExtension({ ...opts(), log: { warn: (o) => warns.push(o) } })(pi as never);
    const result = handler!({ type: "tool_call", toolName: "write", toolCallId: "1", input: { path: "USER.md", content: "x".repeat(5000) } }) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("Curate it first");
    const secret = handler!({ type: "tool_call", toolName: "write", toolCallId: "2", input: { path: "USER.md", content: "sk-abcdefghijklmnopqrstuv" } }) as { reason: string };
    expect(secret.reason).toContain("looks like a secret");
    expect(JSON.stringify(warns)).not.toContain("sk-");
    expect(warns).toEqual([{ tool: "write", rule: "cap:USER.md" }, { tool: "write", rule: "secret" }]);
    expect(handler!({ type: "tool_call", toolName: "write", toolCallId: "3", input: { path: "USER.md", content: "ok" } })).toBeUndefined();
  });
});
