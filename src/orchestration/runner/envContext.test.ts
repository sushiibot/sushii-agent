import { describe, expect, test } from "bun:test";
import { buildEnvironmentContext, probeTools } from "./envContext.ts";

describe("probeTools", () => {
  test("lists only installed tools and parses their version", () => {
    const tools = probeTools((cmd) => {
      if (cmd === "git") return { status: 0, stdout: "git version 2.39.5\n", stderr: "" };
      if (cmd === "pdftotext") return { status: 0, stdout: "", stderr: "pdftotext version 22.02.0\nCopyright" };
      if (cmd === "jq") return { status: 0, stdout: "jq-1.7\n", stderr: "" };
      if (cmd === "node") return { status: 1, stdout: "", stderr: "error: Missing script to execute." };
      return null;
    });
    expect(tools.map((t) => [t.name, t.version])).toEqual([
      ["git", "2.39.5"],
      ["jq", "1.7"],
      ["pdftotext", "22.02.0"],
    ]);
  });
});

describe("buildEnvironmentContext", () => {
  const tools = [{ name: "git", purpose: "version control", version: "2.39.5" }];

  test("describes runner, tools and workspace layout", () => {
    const doc = buildEnvironmentContext(
      { runnerId: "cloud", location: "apps · container", workspaceRoot: "/data/workspace", worktreeTtlHours: 24, platform: "linux", arch: "arm64" },
      tools,
    );
    expect(doc).toContain("runner `cloud` (apps · container), linux/arm64");
    expect(doc).toContain("- `git` 2.39.5 — version control");
    expect(doc).toContain("Repositories are cloned under `/data/workspace`");
    expect(doc).toContain("after 24h idle");
  });

  test("adds a browser section only when agent-browser is installed", () => {
    const facts = { runnerId: "r", location: null, workspaceRoot: null, worktreeTtlHours: 24 };
    expect(buildEnvironmentContext(facts, tools)).not.toContain("## Browser");
    const withBrowser = [...tools, { name: "agent-browser", purpose: "browser", version: "0.38.1" }];
    expect(buildEnvironmentContext(facts, withBrowser)).toContain("## Browser");
  });

  test("omits the workspace section on a runner without clone-on-demand", () => {
    const doc = buildEnvironmentContext({ runnerId: "r", location: null, workspaceRoot: null, worktreeTtlHours: 24 }, tools);
    expect(doc).not.toContain("## Workspace");
  });
});
