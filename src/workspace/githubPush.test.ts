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

test("remembered push permission persists for exactly one repo and branch and can be revoked", async () => {
  const home = mkdtempSync(join(tmpdir(), "github-push-policy-"));
  try {
    const dir = join(home, "projects", "notes");
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Update notes");
    git("remote", "add", "origin", "https://github.com/owner/notes.git");
    const { ChatAsks, createHeadlessUIContext } = await import("./uiContext.ts");
    let approve = false;
    const prompts: import("./uiContext.ts").AskRequest[] = [];
    const asks = new ChatAsks({ deliver: (ask) => { prompts.push(ask); queueMicrotask(() => asks.answer(`wsask:${ask.askId}`, approve ? "Yes" : "No")); } });
    const ctx = { hasUI: true, ui: createHeadlessUIContext(asks) } as ExtensionToolContext;
    const makeTool = () => createGitHubPushTool(home, { envFor: async () => ({}) });
    const execute = (branch = "main", approval?: string) => makeTool().execute("push-id", { path: dir, branch, approval }, undefined, undefined, ctx);
    await expect(execute("main", "remember")).rejects.toThrow("approve");
    await expect(execute()).rejects.toThrow("approve");
    approve = true;
    // An absent credential stops before the actual network push, after owner authorization.
    await expect(execute("main", "remember")).rejects.toThrow("credentials");
    expect(prompts.at(-1)?.toolConfirmation).toMatchObject({ tool: "github_push", toolCallId: "push-id" });
    expect(prompts.at(-1)?.toolConfirmation?.reason).toContain("future ordinary pushes");
    const count = prompts.length;
    await expect(execute()).rejects.toThrow("credentials");
    expect(prompts.length).toBe(count);
    await expect(makeTool().execute("headless", { path: dir, branch: "main" }, undefined, undefined, { hasUI: false } as ExtensionToolContext)).rejects.toThrow("credentials");
    expect(prompts.length).toBe(count);
    approve = false;
    await expect(execute("other")).rejects.toThrow("approve");
    git("remote", "set-url", "origin", "https://github.com/owner/other.git");
    await expect(execute()).rejects.toThrow("approve");
    git("remote", "set-url", "origin", "https://github.com/owner/notes.git");
    await execute("main", "forget");
    await expect(execute()).rejects.toThrow("approve");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
