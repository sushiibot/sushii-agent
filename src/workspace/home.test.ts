import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit } from "../orchestration/runner/runnerGit.ts";
import { MEMORY_MD_CAP, USER_MD_CAP, capContent, commitHome, homeAgentsFilesOverride, loadHomeContextFiles, readHomeTemplate, scaffoldHome } from "./home.ts";

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

  test("the .gitignore allowlist hides everything but the memory and persona files", async () => {
    await scaffoldHome(home);
    writeFileSync(join(home, "projects", "x.txt"), "x");
    writeFileSync(join(home, "scratch", "y.txt"), "y");
    writeFileSync(join(home, ".env.local"), "SECRET=1");
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: x");
    writeFileSync(join(home, ".git-credentials"), "https://x:y@github.com");
    writeFileSync(join(home, "memory", "token.txt"), "ghp_x");
    mkdirSync(join(home, ".agents", "skills", "s"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "s", "credentials.json"), "{}");
    writeFileSync(join(home, ".agents", "skills", "s", "SKILL.md"), "# s");
    writeFileSync(join(home, "memory", "2026-09-29.md"), "note");
    const status = await runnerGit(home).raw(["status", "--porcelain", "--untracked-files=all"]);
    expect(status.trim().split("\n").sort()).toEqual(["?? .agents/skills/s/SKILL.md", "?? memory/2026-09-29.md"]);
  });

  test("finishes a first run that died after git init", async () => {
    await runnerGit(home).init();
    const result = await scaffoldHome(home);
    expect(result.initialized).toBe(true);
    expect(await commitCount()).toBe(1);
    expect((await runnerGit(home).raw(["config", "--local", "user.name"])).trim()).toBe("sushii-workspace");
    expect((await scaffoldHome(home)).initialized).toBe(false);
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

  test("truncation never splits a surrogate pair", () => {
    const { content } = capContent(`${"a".repeat(9)}😀tail`, 10);
    expect(content.startsWith(`${"a".repeat(9)}\n[truncated`)).toBe(true);
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
    await runnerGit(home).raw(["add", "-f", "stray.txt"]);

    const result = await commitHome("memory: flush", { home });

    expect(result.committed).toBe(true);
    const git = runnerGit(home);
    expect(result.sha).toBe((await git.revparse(["HEAD"])).trim());
    const changed = (await git.raw(["show", "--name-only", "--format=", "HEAD"])).trim().split("\n").sort();
    expect(changed).toEqual(["USER.md", "memory/2026-09-29.md"]);
    expect((await git.status()).staged).toEqual(["stray.txt"]);
  });

  test("a rename commits both sides", async () => {
    await scaffoldHome(home);
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(home, "memory", "a.md"), body);
    await commitHome("add a", { home });
    rmSync(join(home, "memory", "a.md"));
    writeFileSync(join(home, "memory", "b.md"), `${body}\nmore`);
    expect((await commitHome("move", { home })).committed).toBe(true);
    const git = runnerGit(home);
    expect((await git.raw(["ls-tree", "-r", "--name-only", "HEAD", "memory/"])).trim()).toBe("memory/b.md");
    expect((await git.raw(["status", "--porcelain"])).trim()).toBe("");
  });

  test("an agent-planted post-commit hook doesn't run", async () => {
    await scaffoldHome(home);
    const marker = join(home, "hook-ran");
    writeFileSync(join(home, ".git", "hooks", "post-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(home, "MEMORY.md"), "- x (src: migrated)\n");
    expect((await commitHome("m", { home })).committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
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
