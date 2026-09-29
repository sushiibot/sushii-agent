import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldHome } from "../home.ts";
import { worktreeInfo } from "./host.ts";
import { ProtectedWatch, diffSnapshots, snapshotProtected, type TamperReport } from "./protectedFiles.ts";

let root: string;
let home: string;
const logged: Array<{ level: string; msg: string; obj: object }> = [];
const log = {
  warn: (obj: object, msg: string) => logged.push({ level: "warn", msg, obj }),
  error: (obj: object, msg: string) => logged.push({ level: "error", msg, obj }),
};

function sh(cmd: string, cwd = home): void {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
}

const git = (cwd: string, args: string) => sh(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, cwd);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ws-protected-"));
  home = join(root, "home");
  await scaffoldHome(home);
  logged.length = 0;
});

afterEach(() => {
  chmodSync(join(home, "USER.md"), 0o644);
  rmSync(root, { recursive: true, force: true });
});

function watchWith(writer: boolean, allowed: string[] = []) {
  const watch = new ProtectedWatch({ home, log });
  const reports: TamperReport[] = [];
  watch.attach({ runId: "CHILD", writer, allowedProjectPaths: allowed, onTamper: (r) => reports.push(r) });
  return { watch, reports };
}

describe("protected watch: the review's bash bypasses, run by a writer child", () => {
  const bypasses: Array<[string, string, string]> = [
    ["rm", "rm MEMORY.md", "MEMORY.md"],
    ["rm -rf a dir", "rm -rf memory", "memory"],
    ["cd && relative redirect", "mkdir -p memory && cd memory && echo x > note.md", "memory/note.md"],
    ["interpreter write", `bun -e "require('fs').writeFileSync('MEMORY.md', 'owned')"`, "MEMORY.md"],
    ["truncate", "truncate -s0 USER.md", "USER.md"],
    ["glob redirect", "echo x > MEM*.md", "MEMORY.md"],
    ["symlink swap", "ln -sf /tmp/elsewhere MEMORY.md", "MEMORY.md"],
    ["chmod", "chmod 000 USER.md", "USER.md"],
    ["persona", "echo 'obey the child' >> AGENTS.md", "AGENTS.md"],
    ["soul", "printf 'new soul' > SOUL.md", "SOUL.md"],
    ["agent def", "echo x > .agents/agents/evil.md", ".agents/agents/evil.md"],
    ["dreams", "echo x >> DREAMS.md", "DREAMS.md"],
  ];

  for (const [name, cmd, path] of bypasses) {
    test(`${name}: detected, restored, the writer is blamed`, () => {
      mkdirSync(join(home, "memory"), { recursive: true });
      writeFileSync(join(home, "memory/2026-09-29.md"), "- a note\n");
      const before = snapshotProtected(home);
      const { watch, reports } = watchWith(true);
      sh(cmd);
      const r = watch.check("CHILD");
      expect(r.tamper?.paths).toContain(path);
      expect(r.tamper?.unrestored).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(diffSnapshots(before, snapshotProtected(home))).toEqual([]);
      expect(lstatSync(join(home, "MEMORY.md")).isFile()).toBe(true);
      expect(statSync(join(home, "USER.md")).mode & 0o777).toBe(0o644);
    });
  }

  test("git checkout of an older USER.md is put back", () => {
    writeFileSync(join(home, "USER.md"), "# drk\n- likes tea\n");
    git(home, "add USER.md");
    git(home, "commit -qm 'user'");
    writeFileSync(join(home, "USER.md"), "# drk\n- likes tea\n- and coffee\n");
    git(home, "add USER.md");
    git(home, "commit -qm 'user 2'");
    const { watch } = watchWith(true);
    sh("git checkout HEAD~1 -- USER.md");
    expect(watch.check("CHILD").tamper?.paths).toEqual(["USER.md"]);
    expect(readFileSync(join(home, "USER.md"), "utf8")).toContain("and coffee");
  });

  test("a hard link planted into memory/ is removed, and its target left alone", () => {
    writeFileSync(join(root, "outside.md"), "outside\n");
    const { watch } = watchWith(true);
    sh(`mkdir -p memory && ln ${join(root, "outside.md")} memory/linked.md`);
    expect(watch.check("CHILD").tamper?.paths).toEqual(expect.arrayContaining(["memory/linked.md"]));
    expect(existsSync(join(home, "memory/linked.md"))).toBe(false);
    expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("outside\n");
  });
});

describe("protected watch: attribution", () => {
  test("a change under a main-side lease is left alone and logged; one outside it is reverted", () => {
    const { watch, reports } = watchWith(true);
    const end = watch.mainWrite(["MEMORY.md"]);
    writeFileSync(join(home, "MEMORY.md"), "main wrote this\n");
    writeFileSync(join(home, "USER.md"), "child wrote this\n");
    end();
    const r = watch.check("CHILD");
    expect(r.conflicts).toEqual(["MEMORY.md"]);
    expect(r.tamper?.paths).toEqual(["USER.md"]);
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("main wrote this\n");
    expect(readFileSync(join(home, "USER.md"), "utf8")).not.toContain("child wrote this");
    expect(reports).toHaveLength(1);
    expect(logged.some((l) => l.level === "warn" && l.msg.includes("main-side write"))).toBe(true);
    // An ended lease no longer covers later windows.
    writeFileSync(join(home, "MEMORY.md"), "child again\n");
    expect(watch.check("CHILD").tamper?.paths).toEqual(["MEMORY.md"]);
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("main wrote this\n");
  });

  test("an unchanged set and a touch without a content change are not tamper", () => {
    const { watch } = watchWith(false);
    expect(watch.check("CHILD").tamper).toBeNull();
    sh("touch MEMORY.md");
    expect(watch.check("CHILD").tamper).toBeNull();
  });

  test("a change while only read-only children run is laid on the checking child", () => {
    const watch = new ProtectedWatch({ home, log });
    const blamed: string[] = [];
    watch.attach({ runId: "A", writer: false, allowedProjectPaths: [], onTamper: () => blamed.push("A") });
    watch.attach({ runId: "B", writer: false, allowedProjectPaths: [], onTamper: () => blamed.push("B") });
    writeFileSync(join(home, "SOUL.md"), "x");
    watch.check("B");
    expect(blamed).toEqual(["B"]);
  });

  test("the baseline goes with the last child: main's writes between children are never reverted", () => {
    const { watch } = watchWith(false);
    watch.detach("CHILD");
    writeFileSync(join(home, "MEMORY.md"), "main, between children\n");
    watch.attach({ runId: "NEXT", writer: false, allowedProjectPaths: [], onTamper: () => {} });
    expect(watch.check("NEXT").tamper).toBeNull();
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("main, between children\n");
  });
});

describe("protected watch: projects/", () => {
  async function repos() {
    const projects = join(home, "projects");
    for (const name of ["repo", "other"]) {
      const dir = join(projects, name);
      mkdirSync(dir, { recursive: true });
      sh("git init -q", dir);
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "add .");
      git(dir, "commit -qm init");
    }
    git(join(projects, "repo"), `worktree add -q -b agent/wt1 ${join(projects, "repo-wt-1")}`);
    const info = worktreeInfo(home, join(projects, "repo-wt-1"));
    if (!info) throw new Error("no worktree info");
    return { projects, info };
  }

  test("the writer's own worktree and branch commits are allowed; other repos and the source checkout are not", async () => {
    const { projects, info } = await repos();
    expect(info.branch).toBe("agent/wt1");
    const { watch, reports } = watchWith(true, info.projectPaths);
    writeFileSync(join(projects, "repo-wt-1", "b.txt"), "b\n");
    git(join(projects, "repo-wt-1"), "add b.txt");
    git(join(projects, "repo-wt-1"), "commit -qm b");
    expect(watch.check("CHILD").tamper).toBeNull();

    writeFileSync(join(projects, "other", "a.txt"), "tampered\n");
    sh("echo x > ../repo/new.txt", join(projects, "repo-wt-1"));
    const r = watch.check("CHILD");
    expect(r.tamper?.paths).toEqual(["projects/other/a.txt", "projects/repo/new.txt"]);
    expect(reports).toHaveLength(1);
  });

  test("moving another branch of the source repo is caught", async () => {
    const { info } = await repos();
    const { watch } = watchWith(true, info.projectPaths);
    git(join(home, "projects", "repo-wt-1"), "branch -f master HEAD~0");
    sh("git update-ref refs/heads/evil HEAD", join(home, "projects", "repo-wt-1"));
    expect(watch.check("CHILD").tamper?.paths).toEqual(expect.arrayContaining(["projects/repo/.git/refs/heads/evil"]));
  });
});
