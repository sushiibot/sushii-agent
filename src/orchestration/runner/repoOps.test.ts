import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import simpleGit from "simple-git";
import { pushWorkAndOpenPr, type RepoOpsDeps } from "./repoOps.ts";

const bot = { name: "sushii-runner[bot]", email: "bot@example.com" };

function fakeDeps(prUrl = "https://github.com/acme/widgets/pull/1"): { deps: RepoOpsDeps; prPayloads: unknown[] } {
  const prPayloads: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/repos/acme/widgets")) {
      return { ok: true, status: 200, json: async () => ({ default_branch: "main" }) } as Response;
    }
    prPayloads.push(JSON.parse(init!.body as string));
    return { ok: true, status: 201, json: async () => ({ html_url: prUrl }) } as Response;
  }) as unknown as typeof fetch;
  return {
    deps: { provider: { tokenFor: async () => ({ token: "ghs_x", expiresAt: Date.now() + 3600_000 }) }, bot, fetchImpl },
    prPayloads,
  };
}

describe("pushWorkAndOpenPr", () => {
  let dir: string;
  let origin: string;
  let cwd: string;
  let startSha: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "repoops-"));
    origin = join(dir, "origin.git");
    cwd = join(dir, "work");
    await simpleGit().init(["--bare", origin, "--initial-branch=main"]);
    await simpleGit().clone(origin, cwd);
    const wg = simpleGit(cwd);
    await wg.addConfig("user.name", "seed");
    await wg.addConfig("user.email", "seed@x");
    await wg.checkout(["-B", "main"]);
    writeFileSync(join(cwd, "README.md"), "seed\n");
    await wg.add(["-A"]);
    await wg.commit("seed");
    await wg.push(["origin", "main"]);
    startSha = (await wg.revparse(["HEAD"])).trim();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("commits working-tree changes onto a task branch, pushes it, opens a draft PR against default", async () => {
    writeFileSync(join(cwd, "feature.txt"), "the agent's work\n");
    const { deps, prPayloads } = fakeDeps();

    const result = await pushWorkAndOpenPr(cwd, { owner: "acme", repo: "widgets" }, { taskId: "task-1", summary: "Add feature", startSha }, deps);

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("sushii-runner/task-1");
    expect(result!.prUrl).toBe("https://github.com/acme/widgets/pull/1");
    // The branch reached the origin, and main is untouched (branch-only, enforced by construction).
    const branches = await simpleGit(origin).branch();
    expect(branches.all).toContain("sushii-runner/task-1");
    expect(prPayloads[0]).toMatchObject({ head: "sushii-runner/task-1", base: "main", draft: true, title: "Add feature" });
  });

  test("returns null and opens no PR when the agent changed nothing", async () => {
    const { deps, prPayloads } = fakeDeps();
    const result = await pushWorkAndOpenPr(cwd, { owner: "acme", repo: "widgets" }, { taskId: "task-2", summary: "noop", startSha }, deps);
    expect(result).toBeNull();
    expect(prPayloads).toHaveLength(0);
    // A no-op must not mutate the checkout — identity is only rewritten when there is work to push.
    expect((await simpleGit(cwd).getConfig("user.name")).value).toBe("seed");
  });

  test("does not persist the token into .git/config", async () => {
    writeFileSync(join(cwd, "x.txt"), "y\n");
    const { deps } = fakeDeps();
    await pushWorkAndOpenPr(cwd, { owner: "acme", repo: "widgets" }, { taskId: "task-3", summary: "x", startSha }, deps);
    const config = await simpleGit(cwd).listConfig();
    const serialized = JSON.stringify(config.all);
    expect(serialized).not.toContain("ghs_x");
    expect(serialized).not.toContain("extraheader");
  });
});
