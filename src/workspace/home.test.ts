import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit } from "../agentRuntime/runnerGit.ts";
import { loadAgentDefs } from "./subagents/agentDefs.ts";
import { MEMORY_CATALOG_CAP, MEMORY_MD_CAP, MEMORY_PATHS, USER_MD_CAP, capContent, commitHome, homeAgentsFilesOverride, loadHomeContextFiles, readHomeTemplate, scaffoldHome } from "./home.ts";
import { UPGRADABLE_TEMPLATES, sha256, upgradeHomeTemplates } from "./homeUpgrade.ts";
import { SHIPPED_TEMPLATE_HASHES } from "./homeTemplateHashes.ts";

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

    for (const f of ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md", "DREAMS.md", "memory/catalog.md", "TASKS.md", "tasks/README.md", ".agents/skills/README.md", ".agents/skills/session-history/SKILL.md", ".agents/skills/documents/SKILL.md", ".gitignore"]) {
      expect(existsSync(join(home, f))).toBe(true);
    }
    for (const d of ["memory/topics", "tasks/archive", "projects", "scratch", ".agents/skills"]) expect(existsSync(join(home, d))).toBe(true);
    expect(result.initialized).toBe(true);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(readHomeTemplate("AGENTS.md"));

    const git = runnerGit(home);
    expect(await commitCount()).toBe(1);
    expect((await git.raw(["config", "--local", "user.name"])).trim()).toBe("sushii-workspace");
    expect((await git.raw(["config", "--local", "user.email"])).trim()).toBe("workspace@localhost");
    const files = (await git.raw(["ls-files"])).trim().split("\n").sort();
    expect(files).toEqual([
      ".agents/agents/coder.md",
      ".agents/agents/explore.md",
      ".agents/agents/researcher.md",
      ".agents/agents/reviewer.md",
      ".agents/skills/README.md",
      ".agents/skills/documents/SKILL.md",
      ".agents/skills/session-history/SKILL.md",
      ".gitignore",
      "AGENTS.md",
      "DREAMS.md",
      "MEMORY.md",
      "SOUL.md",
      "TASKS.md",
      "USER.md",
      "memory/catalog.md",
      "schedule.md",
      "tasks/README.md",
    ]);
  });

  test("an older home's .gitignore is opened up for TASKS.md and tasks/, and they commit with memory", async () => {
    await scaffoldHome(home);
    const ignore = join(home, ".gitignore");
    writeFileSync(ignore, readFileSync(ignore, "utf8").replace("!/TASKS.md\n!/tasks/\n", ""));
    await scaffoldHome(home);
    await scaffoldHome(home);
    const lines = readFileSync(ignore, "utf8").split("\n");
    expect(lines.filter((l) => l === "!/TASKS.md")).toHaveLength(1);
    expect(lines.filter((l) => l === "!/tasks/")).toHaveLength(1);
    writeFileSync(join(home, "TASKS.md"), "# TASKS.md\n\n## Quick\n- [ ] x\n");
    writeFileSync(join(home, "tasks", "trip.md"), "# Trip\nstatus: active\n");
    expect((await commitHome("tasks", { home, paths: MEMORY_PATHS })).committed).toBe(true);
    const tracked = (await runnerGit(home).raw(["ls-files", "tasks"])).trim().split("\n");
    expect(tracked).toContain("tasks/trip.md");
  });

  test("scaffolding never overwrites TASKS.md or tasks/README.md", async () => {
    writeFileSync(join(home, "TASKS.md"), "# mine\n");
    mkdirSync(join(home, "tasks"), { recursive: true });
    writeFileSync(join(home, "tasks", "README.md"), "my readme\n");
    await scaffoldHome(home);
    expect(readFileSync(join(home, "TASKS.md"), "utf8")).toBe("# mine\n");
    expect(readFileSync(join(home, "tasks", "README.md"), "utf8")).toBe("my readme\n");
  });

  test("an older home's .gitignore is opened up for schedule.md, once", async () => {
    await scaffoldHome(home);
    const ignore = join(home, ".gitignore");
    writeFileSync(ignore, readFileSync(ignore, "utf8").replace("!/schedule.md\n", ""));
    await scaffoldHome(home);
    await scaffoldHome(home);
    expect(readFileSync(ignore, "utf8").split("\n").filter((l) => l === "!/schedule.md")).toHaveLength(1);
    writeFileSync(join(home, "schedule.md"), "# edited\n");
    expect((await commitHome("schedule", { home, paths: ["schedule.md"] })).committed).toBe(true);
  });

  test("scaffolds the default agent defs without overwriting an edited one", async () => {
    const explore = join(home, ".agents/agents/explore.md");
    mkdirSync(join(home, ".agents/agents"), { recursive: true });
    writeFileSync(explore, "---\nname: explore\ndescription: mine\n---\nmy prompt\n");
    const result = await scaffoldHome(home);
    expect(result.created).not.toContain(".agents/agents/explore.md");
    expect(result.created).toEqual(expect.arrayContaining([".agents/agents/researcher.md", ".agents/agents/reviewer.md", ".agents/agents/coder.md"]));
    expect(readFileSync(explore, "utf8")).toContain("my prompt");
    const defs = loadAgentDefs(home);
    expect([...defs.keys()].sort()).toEqual(["coder", "explore", "researcher", "reviewer"]);
    expect(defs.get("explore")!.description).toBe("mine");
    expect(defs.get("coder")).toMatchObject({ writer: true, background: true, tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] });
    expect(defs.get("reviewer")).toMatchObject({ writer: false, tools: ["read", "grep", "find", "ls"] });
    expect(defs.get("researcher")).toMatchObject({ writer: false, tools: ["read", "grep", "find", "ls"] });
  });

  test("scaffolds the session-history skill but never overwrites an existing one", async () => {
    const skill = join(home, ".agents/skills/session-history/SKILL.md");
    mkdirSync(join(home, ".agents/skills/session-history"), { recursive: true });
    writeFileSync(skill, "my edited skill\n");
    const result = await scaffoldHome(home);
    expect(result.created).not.toContain(".agents/skills/session-history/SKILL.md");
    expect(readFileSync(skill, "utf8")).toBe("my edited skill\n");

    const fresh = mkdtempSync(join(tmpdir(), "ws-home-"));
    try {
      await scaffoldHome(fresh);
      const content = readFileSync(join(fresh, ".agents/skills/session-history/SKILL.md"), "utf8");
      expect(content).toBe(readHomeTemplate(".agents/skills/session-history/SKILL.md"));
      expect(content).toMatch(/^---\nname: session-history\ndescription: .+\n---/);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("scaffolds the documents skill with agentskills frontmatter", async () => {
    await scaffoldHome(home);
    const content = readFileSync(join(home, ".agents/skills/documents/SKILL.md"), "utf8");
    expect(content).toBe(readHomeTemplate(".agents/skills/documents/SKILL.md"));
    expect(content).toMatch(/^---\nname: documents\ndescription: .+\n---/);
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
  test("loads the bounded catalog and leaves topic bodies on disk", async () => {
    await scaffoldHome(home);
    const catalog = join(home, "memory/catalog.md");
    writeFileSync(join(home, "memory/topics/decision.md"), "detail that stays outside orientation");
    writeFileSync(catalog, "c".repeat(MEMORY_CATALOG_CAP + 10));
    const files = loadHomeContextFiles(home);
    expect(files.find((f) => f.path === catalog)!.content).toContain(`[truncated at ${MEMORY_CATALOG_CAP} chars`);
    expect(files.some((f) => f.content.includes("detail that stays"))).toBe(false);
    writeFileSync(catalog, "- [Decision](memory/topics/decision.md) — Read when: choosing the backend.\n");
    expect(loadHomeContextFiles(home).find((f) => f.path === catalog)!.content).toContain("choosing the backend");
  });
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
      expect(files.map((f) => f.path)).toEqual(["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md", "memory/catalog.md", "TASKS.md"].map((f) => join(home, f)));
      expect(files[2]!.content).toContain(`[truncated at ${USER_MD_CAP} chars — curate this file]`);

      writeFileSync(join(home, "USER.md"), "- fresh fact (src: migrated)\n");
      await loader.reload();
      expect(loader.getAgentsFiles().agentsFiles[2]!.content).toBe("- fresh fact (src: migrated)\n");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("TASKS.md as a context file", () => {
  test("loaded last, with stale items marked, capped", () => {
    writeFileSync(join(home, "TASKS.md"), "# TASKS.md\n\n## Quick\n- [ ] Dentist (id: t-1) updated:2026-09-20\n");
    const files = loadHomeContextFiles(home, { now: () => new Date("2026-09-29T12:00:00Z") });
    expect(files.at(-1)).toEqual({ path: join(home, "TASKS.md"), content: "# TASKS.md\n\n## Quick\n- [ ] Dentist (id: t-1) updated:2026-09-20 (stale 9d)\n" });
    writeFileSync(join(home, "TASKS.md"), `## Quick\n${"- [ ] x updated:2026-09-29\n".repeat(400)}`);
    expect(loadHomeContextFiles(home).at(-1)!.content.length).toBeLessThan(3100);
  });
});

describe("template upgrade", () => {
  const OLD_MANUAL = "# AGENTS.md: an old shipped manual\n";
  const OLD_IGNORE = "/*\n!/.gitignore\n!/AGENTS.md\n";

  test("a home file identical to an earlier shipped template is replaced and committed; an edited one is left alone", async () => {
    await scaffoldHome(home);
    writeFileSync(join(home, "AGENTS.md"), OLD_MANUAL);
    writeFileSync(join(home, "SOUL.md"), "drk's own soul\n");
    writeFileSync(join(home, "USER.md"), OLD_MANUAL);
    await runnerGit(home).add(["-A", "--", "AGENTS.md", "SOUL.md", "USER.md"]).commit("old home");
    const infos: string[] = [];
    const hashes = { "AGENTS.md": [sha256(OLD_MANUAL)], "SOUL.md": [sha256("an older soul\n")], "USER.md": [sha256(OLD_MANUAL)] };
    const upgraded = await upgradeHomeTemplates(home, {
      hashes,
      log: { info: (_o, m) => infos.push(m), warn: () => {} },
      commit: (path, message) => commitHome(message, { home, paths: [path] }),
    });
    expect(upgraded).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(readHomeTemplate("AGENTS.md"));
    expect(readFileSync(join(home, "SOUL.md"), "utf8")).toBe("drk's own soul\n");
    expect(readFileSync(join(home, "USER.md"), "utf8")).toBe(OLD_MANUAL);
    expect(infos).toContain("SOUL.md differs from the shipped template; not upgraded");
    expect((await runnerGit(home).raw(["log", "-1", "--format=%s"])).trim()).toBe("home: upgrade AGENTS.md template");
  });

  test("scaffoldHome upgrades an older .gitignore even with the allow lines it appended", async () => {
    await scaffoldHome(home);
    writeFileSync(join(home, ".gitignore"), `${OLD_IGNORE}!/schedule.md\n`);
    await scaffoldHome(home, { templateHashes: { gitignore: [sha256(OLD_IGNORE)] } });
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toBe(readHomeTemplate(".gitignore"));
  });

  test("memory and tasks are never upgradable; no current template is listed as an old one", () => {
    for (const p of ["USER.md", "MEMORY.md", "DREAMS.md", "memory/catalog.md", "TASKS.md", "tasks/README.md"]) expect(Object.keys(UPGRADABLE_TEMPLATES)).not.toContain(p);
    for (const [homePath, file] of Object.entries(UPGRADABLE_TEMPLATES)) {
      expect(SHIPPED_TEMPLATE_HASHES[file]).toBeDefined();
      expect(SHIPPED_TEMPLATE_HASHES[file]).not.toContain(sha256(readHomeTemplate(homePath)));
    }
  });
});

describe("commitHome", () => {
  test("an existing home gains topic tracking without overwriting its catalog", async () => {
    await scaffoldHome(home);
    const catalog = join(home, "memory/catalog.md");
    writeFileSync(catalog, "my catalog\n");
    const ignore = join(home, ".gitignore");
    writeFileSync(ignore, readFileSync(ignore, "utf8").replace("!/memory/topics/\n/memory/topics/*\n!/memory/topics/*.md\n", ""));
    await scaffoldHome(home);
    await scaffoldHome(home);
    expect(readFileSync(catalog, "utf8")).toBe("my catalog\n");
    expect(readFileSync(ignore, "utf8").split("\n").filter((l) => l === "!/memory/topics/")).toHaveLength(1);
    writeFileSync(join(home, "memory/topics/backend.md"), "# Backend\nverified: unverified\n");
    writeFileSync(join(home, "memory/topics/private.txt"), "not a topic");
    writeFileSync(join(home, "memory/topics/.env"), "not versioned");
    expect((await commitHome("memory: topic", { home, paths: MEMORY_PATHS })).committed).toBe(true);
    const tracked = (await runnerGit(home).raw(["ls-files", "memory/"])).trim().split("\n");
    expect(tracked).toEqual(["memory/catalog.md", "memory/topics/backend.md"]);
  });
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
    expect((await git.raw(["ls-tree", "-r", "--name-only", "HEAD", "memory/"])).trim().split("\n")).toEqual(["memory/b.md", "memory/catalog.md"]);
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
