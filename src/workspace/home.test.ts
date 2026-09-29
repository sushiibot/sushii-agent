import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit } from "../orchestration/runner/runnerGit.ts";
import { MEMORY_MD_CAP, USER_MD_CAP, commitHome, homeAgentsFilesOverride, loadHomeContextFiles, readHomeTemplate, scaffoldHome } from "./home.ts";

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  // Keep the developer's global git config (signing, hooks) out of the temp repos.
  for (const [k, v] of Object.entries(GIT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const k of Object.keys(GIT_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ws-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function commitCount(): Promise<number> {
  return Number((await runnerGit(home).raw(["rev-list", "--count", "HEAD"])).trim());
}

describe("scaffoldHome", () => {
  test("creates the layout, git-inits and commits the scaffold", async () => {
    const result = await scaffoldHome(home);

    for (const f of ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md", "DREAMS.md", ".agents/skills/README.md", ".gitignore"]) {
      expect(existsSync(join(home, f))).toBe(true);
    }
    for (const d of ["memory", "projects", "scratch", ".agents/skills"]) expect(existsSync(join(home, d))).toBe(true);
    expect(result.initialized).toBe(true);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(readHomeTemplate("AGENTS.md"));

    const gitignore = readFileSync(join(home, ".gitignore"), "utf8").split("\n");
    for (const entry of ["projects/", "scratch/", "node_modules/", ".bun/", ".local/", ".npm-global/", ".cache/", "*.env", ".env*"]) {
      expect(gitignore).toContain(entry);
    }

    const git = runnerGit(home);
    expect(await commitCount()).toBe(1);
    expect((await git.raw(["config", "--local", "user.name"])).trim()).toBe("sushii-workspace");
    expect((await git.raw(["config", "--local", "user.email"])).trim()).toBe("workspace@localhost");
    const files = (await git.raw(["ls-files"])).trim().split("\n").sort();
    expect(files).toEqual([".agents/skills/README.md", ".gitignore", "AGENTS.md", "DREAMS.md", "MEMORY.md", "SOUL.md", "USER.md"]);
  });

  test("never overwrites existing files and git-inits only once", async () => {
    writeFileSync(join(home, "SOUL.md"), "my own soul\n");
    await scaffoldHome(home);
    expect(readFileSync(join(home, "SOUL.md"), "utf8")).toBe("my own soul\n");

    writeFileSync(join(home, "AGENTS.md"), "edited manual\n");
    rmSync(join(home, "DREAMS.md"));
    const second = await scaffoldHome(home);

    expect(second).toEqual({ created: ["DREAMS.md"], initialized: false });
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("edited manual\n");
    expect(await commitCount()).toBe(1);
  });

  test("ignored dirs never get committed", async () => {
    await scaffoldHome(home);
    writeFileSync(join(home, "projects", "x.txt"), "x");
    writeFileSync(join(home, "scratch", "y.txt"), "y");
    writeFileSync(join(home, ".env.local"), "SECRET=1");
    const status = await runnerGit(home).status();
    expect(status.not_added).toEqual([]);
  });
});

describe("home context files", () => {
  test("SOUL, USER, MEMORY in order; missing files skipped", async () => {
    writeFileSync(join(home, "MEMORY.md"), "mem");
    writeFileSync(join(home, "SOUL.md"), "soul");
    expect(loadHomeContextFiles(home)).toEqual([
      { path: join(home, "SOUL.md"), content: "soul" },
      { path: join(home, "MEMORY.md"), content: "mem" },
    ]);
  });

  test("USER.md and MEMORY.md are truncated at their caps with a marker", () => {
    writeFileSync(join(home, "USER.md"), "u".repeat(USER_MD_CAP + 50));
    writeFileSync(join(home, "MEMORY.md"), "m".repeat(MEMORY_MD_CAP));
    const [user, memory] = loadHomeContextFiles(home);
    expect(user!.content).toBe(`${"u".repeat(USER_MD_CAP)}\n[truncated at ${USER_MD_CAP} chars — curate this file]\n`);
    expect(memory!.content).toBe("m".repeat(MEMORY_MD_CAP));
  });

  test("Pi's resource loader yields ~/AGENTS.md first, then SOUL/USER/MEMORY, re-read on reload", async () => {
    await scaffoldHome(home);
    writeFileSync(join(home, "USER.md"), `${"u".repeat(USER_MD_CAP)}extra`);
    const agentDir = mkdtempSync(join(tmpdir(), "ws-agentdir-"));
    try {
      const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
      const loader = new DefaultResourceLoader({
        cwd: home,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        agentsFilesOverride: homeAgentsFilesOverride(home),
      });
      await loader.reload();
      const files = loader.getAgentsFiles().agentsFiles;
      expect(files.map((f) => f.path)).toEqual(["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"].map((f) => join(home, f)));
      expect(files[2]!.content).toContain(`[truncated at ${USER_MD_CAP} chars — curate this file]`);

      writeFileSync(join(home, "USER.md"), "- fresh fact (src: migrated)\n");
      await loader.reload();
      expect(loader.getAgentsFiles().agentsFiles[2]!.content).toBe("- fresh fact (src: migrated)\n");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("commitHome", () => {
  test("no-op when nothing tracked changed, even with an empty memory/ dir", async () => {
    await scaffoldHome(home);
    expect(await commitHome("nothing", { home })).toEqual({ committed: false });
    expect(await commitCount()).toBe(1);
  });

  test("commits memory changes only, leaving other files alone", async () => {
    await scaffoldHome(home);
    writeFileSync(join(home, "USER.md"), "- likes tea (src: migrated)\n");
    writeFileSync(join(home, "memory", "2026-09-29.md"), "note\n");
    writeFileSync(join(home, "stray.txt"), "not memory\n");

    const result = await commitHome("memory: flush", { home });

    expect(result.committed).toBe(true);
    const git = runnerGit(home);
    expect(result.sha).toBe((await git.revparse(["HEAD"])).trim());
    const changed = (await git.raw(["show", "--name-only", "--format=", "HEAD"])).trim().split("\n").sort();
    expect(changed).toEqual(["USER.md", "memory/2026-09-29.md"]);
    expect((await git.status()).not_added).toEqual(["stray.txt"]);
  });

  test("commits a deleted tracked file and serializes concurrent calls", async () => {
    await scaffoldHome(home);
    rmSync(join(home, "DREAMS.md"));
    writeFileSync(join(home, "MEMORY.md"), "- x (src: migrated)\n");
    const [a, b] = await Promise.all([commitHome("one", { home }), commitHome("two", { home })]);
    expect(a.committed).toBe(true);
    expect(b).toEqual({ committed: false });
    expect(await commitCount()).toBe(2);
    expect((await runnerGit(home).raw(["ls-files", "DREAMS.md"])).trim()).toBe("");
  });
});
