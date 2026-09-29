import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMemoryWrite, containsSecret, createMemoryGuardExtension, scanMemoryForSecrets } from "./memoryGuard.ts";
import { redact } from "./wsRuns.ts";

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

  // Fake values in each provider's documented shape.
  const shaped = {
    discordBotToken: "MTA5ODc2NTQzMjEwOTg3NjU0.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789",
    googleApiKey: `AIza${"Sy0123456789abcdefghijklmnopqrstuv"}`,
    awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
    slackToken: "xoxb-1234567890-abcdefghij",
    stripeKey: "sk_live_abcdefghijklmnop1234",
    lonePayloadJwt: "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n-----END OPENSSH PRIVATE KEY-----",
  };

  test.each(Object.entries(shaped))("flags a %s, and ws-runs redacts it with the same list", (_name, secret) => {
    expect(containsSecret(`note: ${secret} end`)).toBe(true);
    expect(redact(`note: ${secret} end`)).toBe("note: [REDACTED] end");
  });

  test("leaves ordinary identifiers alone", () => {
    for (const keep of ["AKIA is a prefix", "xox-style", "the file home.test.ts", "session-history-skill-template-directory"]) {
      expect(containsSecret(keep)).toBe(false);
    }
  });
});

describe("checkMemoryWrite", () => {
  test("read-only (a subagent) refuses every memory write but leaves other paths alone", () => {
    const ro = { ...opts(), readOnly: true };
    expect(checkMemoryWrite("edit", edit("USER.md", "- Likes tea.", "- Likes green tea."), ro)).toBe("read-only");
    expect(checkMemoryWrite("write", { path: "memory/2026-09-29.md", content: "- met Sam\n" }, ro)).toBe("read-only");
    expect(checkMemoryWrite("bash", { command: "echo hi >> memory/2026-09-29.md" }, ro)).toBe("read-only");
    expect(checkMemoryWrite("bash", { command: "cat MEMORY.md" }, ro)).toBeNull();
    expect(checkMemoryWrite("write", { path: "scratch/notes.md", content: "x" }, ro)).toBeNull();
  });

  test("read-only also covers persona and agent files; writable roots confine a writer's edits", () => {
    const ro = { ...opts(), readOnly: true };
    expect(checkMemoryWrite("write", { path: "AGENTS.md", content: "x" }, ro)).toBe("read-only");
    expect(checkMemoryWrite("edit", edit("SOUL.md", "a", "b"), ro)).toBe("read-only");
    expect(checkMemoryWrite("write", { path: ".agents/agents/evil.md", content: "x" }, ro)).toBe("read-only");
    expect(checkMemoryWrite("bash", { command: "echo x >> AGENTS.md" }, ro)).toBe("read-only");
    expect(checkMemoryWrite("edit", edit("schedule.md", "a", "b"), ro)).toBe("read-only");
    expect(checkMemoryWrite("bash", { command: "echo x >> schedule.md" }, ro)).toBe("read-only");
    expect(checkMemoryWrite("write", { path: "AGENTS.md", content: "x" }, opts())).toBeNull();
    expect(checkMemoryWrite("edit", edit("schedule.md", "a", "b"), opts())).toBeNull();

    const wt = join(home, "projects", "repo-wt-1");
    mkdirSync(wt, { recursive: true });
    const writer = { home, cwd: wt, readOnly: true, writableRoots: [wt, join(home, "scratch")] };
    expect(checkMemoryWrite("write", { path: "src/a.ts", content: "x" }, writer)).toBeNull();
    expect(checkMemoryWrite("write", { path: join(home, "scratch", "n.md"), content: "x" }, writer)).toBeNull();
    expect(checkMemoryWrite("write", { path: "../other/a.ts", content: "x" }, writer)).toBe("outside");
    expect(checkMemoryWrite("edit", edit("../../SOUL.md", "a", "b"), writer)).toBe("read-only");
  });

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

  test("guards DREAMS.md for secrets, without a cap", () => {
    expect(checkMemoryWrite("write", { path: "DREAMS.md", content: "x".repeat(20_000) }, opts())).toBeNull();
    expect(checkMemoryWrite("write", { path: "DREAMS.md", content: "AKIAIOSFODNN7EXAMPLE" }, opts())).toBe("secret");
    expect(checkMemoryWrite("bash", { command: "echo AKIAIOSFODNN7EXAMPLE >> DREAMS.md" }, opts())).toBe("secret");
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

describe("scanMemoryForSecrets", () => {
  test("names the memory files holding something secret-shaped", () => {
    writeFileSync(join(home, "memory", "2026-09-29.md"), "- key AKIAIOSFODNN7EXAMPLE\n");
    writeFileSync(join(home, "notes.md"), "sk-abcdefghijklmnopqrstuv");
    expect(scanMemoryForSecrets(home)).toEqual(["memory/2026-09-29.md"]);
  });
});
