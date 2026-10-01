import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildAgentEnv } from "../agentRuntime/agentEnv.ts";
import { repoFromRemoteUrl, type GitHubCredentials } from "./githubCredentials.ts";

const run = promisify(execFile);
export const GITHUB_PUSH_TOOL = "github_push";

/** One explicitly approved, ordinary push. The hook grant pins the URL, ref and commit shown to the owner. */
export function createGitHubPushTool(home: string, github: Pick<GitHubCredentials, "envFor">): ToolDefinition {
  return {
    name: GITHUB_PUSH_TOOL,
    label: "Push to GitHub",
    description:
      "Push the current commit to a GitHub branch, including main when the owner requested it. Always asks the owner to approve the exact repository, branch and commit. Never force-pushes. Use this for an owner-requested direct push; autonomous work uses a task branch and PR.",
    parameters: Type.Object({
      path: Type.String({ description: "Repository directory under ~/projects" }),
      branch: Type.String({ description: "Destination branch, e.g. main" }),
    }),
    execute: async (_id, raw, signal, _update, ctx) => {
      const input = raw as { path: string; branch: string };
      const projects = realpathSync(resolve(home, "projects"));
      const dir = realpathSync(resolve(home, input.path));
      const rel = relative(projects, dir);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Pushes must use a repository under ~/projects.");
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch)) throw new Error("Invalid branch name.");
      const git = async (args: string[], extra: Record<string, string> = {}) => {
        const result = await run("git", ["-C", dir, ...args], {
          env: buildAgentEnv(process.env, extra, { dropPrefixes: ["PI_"] }),
          signal,
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        });
        return result.stdout.trim();
      };
      await git(["check-ref-format", `refs/heads/${input.branch}`]);
      const url = await git(["remote", "get-url", "--push", "origin"]);
      const repo = repoFromRemoteUrl(url);
      if (!repo || !url.startsWith("https://github.com/")) throw new Error("Use a clean https://github.com origin push URL.");
      const sha = await git(["rev-parse", "HEAD"]);
      const summary = await git(["log", "-1", "--format=%s"]);
      if (!ctx.hasUI || !(await ctx.ui.confirm("Approve GitHub push", `${repo} → ${input.branch}\n${sha}\n${summary}`, { signal })))
        throw new Error("The owner did not approve this push.");
      const env = await github.envFor("git push", dir);
      if (!env.GH_TOKEN) throw new Error("GitHub credentials are unavailable.");
      // The explicit SHA prevents a new commit created while approval was pending from being pushed.
      if ((await git(["remote", "get-url", "--push", "origin"])) !== url)
        throw new Error("The push destination changed while approval was pending. Ask again.");
      const result = await git(["push", url, `${sha}:refs/heads/${input.branch}`], {
        ...env,
        SUSHII_APPROVED_PUSH_URL: url,
        SUSHII_APPROVED_PUSH_REF: `refs/heads/${input.branch}`,
        SUSHII_APPROVED_PUSH_SHA: sha,
      });
      return { content: [{ type: "text", text: result || `Pushed ${sha} to ${repo}:${input.branch}.` }], details: {} };
    },
  };
}
