import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createGitHubPushTool } from "./githubPush.ts";

test("direct push requires owner approval of the repository, ref and commit; denial never requests credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "github-push-"));
  try {
    const dir = join(home, "projects", "notes");
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Update notes");
    git("remote", "add", "origin", "https://github.com/owner/notes.git");
    let credentialCalls = 0;
    let shown = "";
    const tool = createGitHubPushTool(home, {
      envFor: async () => {
        credentialCalls++;
        return {};
      },
    });
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async (_title: string, body: string) => {
          shown = body;
          return false;
        },
      },
    } as unknown as ExtensionToolContext;
    await expect(tool.execute("push", { path: dir, branch: "main" }, undefined, undefined, ctx)).rejects.toThrow("approve");
    expect(shown).toContain("owner/notes → main");
    expect(shown).toContain(git("rev-parse", "HEAD"));
    expect(shown).toContain("Update notes");
    expect(credentialCalls).toBe(0);
    await expect(tool.execute("push", { path: dir, branch: "main" }, undefined, undefined, { hasUI: false } as ExtensionToolContext)).rejects.toThrow(
      "approve",
    );
    expect(credentialCalls).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
