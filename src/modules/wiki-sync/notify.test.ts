import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { buildRecapBody, buildStatusContent, deriveWebUrl } from "./notify.ts";
import type { WikiRepo } from "./git.ts";

describe("deriveWebUrl", () => {
  test("converts an ssh URL with a port to an https URL", () => {
    expect(deriveWebUrl("ssh://git@git.dreamcatcher.inc:2222/dreamcatcher/wiki.git")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("converts an ssh URL without a port", () => {
    expect(deriveWebUrl("ssh://git@github.com/sushiibot/wiki.git")).toBe("https://github.com/sushiibot/wiki");
  });

  test("handles a repo path without a .git suffix", () => {
    expect(deriveWebUrl("ssh://git@git.dreamcatcher.inc:2222/dreamcatcher/wiki")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("converts an https URL, stripping .git", () => {
    expect(deriveWebUrl("https://git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("strips embedded credentials from an https URL", () => {
    expect(deriveWebUrl("https://oauth2:secret-token@git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("returns null for an unsupported scheme", () => {
    expect(deriveWebUrl("git://git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(deriveWebUrl("")).toBeNull();
  });
});

describe("buildStatusContent", () => {
  test("returns just the commit line when there's no recap", () => {
    expect(buildStatusContent(null, "[View commit](https://example.com/commit/abc)")).toBe(
      "[View commit](https://example.com/commit/abc)",
    );
  });

  test("joins a short recap with the commit line unchanged", () => {
    const result = buildStatusContent("- someone shared a paper", "[View commit](https://example.com/commit/abc)");
    expect(result).toBe("- someone shared a paper\n\n[View commit](https://example.com/commit/abc)");
  });

  test("truncates a long recap but always preserves the commit link", () => {
    const commitLine = "[View commit](https://example.com/commit/abc)";
    const longRecap = "x".repeat(5000);

    const result = buildStatusContent(longRecap, commitLine);

    expect(result.endsWith(commitLine)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(3800);
  });

  test("truncated recap ends with an ellipsis before the commit link", () => {
    const commitLine = "[View commit](https://example.com/commit/abc)";
    const result = buildStatusContent("x".repeat(5000), commitLine);
    const recapPart = result.slice(0, result.indexOf("\n\n"));
    expect(recapPart.endsWith("…")).toBe(true);
  });
});

describe("buildRecapBody", () => {
  async function makeRepo(): Promise<WikiRepo> {
    const dir = await mkdtemp(join(tmpdir(), "wiki-sync-notify-test-"));
    const git = simpleGit({ baseDir: dir });
    await git.init();
    await git.addConfig("user.name", "test");
    await git.addConfig("user.email", "test@example.com");
    return { dir, git };
  }

  test("shows a brand-new recap file's content in full, with no webUrl configured", async () => {
    const repo = await makeRepo();
    try {
      await mkdir(join(repo.dir, "recaps"), { recursive: true });
      const recapPath = join(repo.dir, "recaps", "2026-08-22.md");

      await writeFile(recapPath, "## 2026-08-22\n- first thing someone shared\n", "utf8");
      await repo.git.add(["-A"]);
      const first = await repo.git.commit("first sweep");

      const recap = await buildRecapBody(repo, first.commit, null);
      expect(recap).toBe("## 2026-08-22\n- first thing someone shared");
    } finally {
      await rm(repo.dir, { recursive: true, force: true });
    }
  });

  test("only points at a recap file the commit revisited, not its full content", async () => {
    const repo = await makeRepo();
    try {
      await mkdir(join(repo.dir, "recaps"), { recursive: true });
      const recapPath = join(repo.dir, "recaps", "2026-08-22.md");

      await writeFile(recapPath, "## 2026-08-22\n- first thing someone shared\n", "utf8");
      await repo.git.add(["-A"]);
      await repo.git.commit("first sweep");

      await writeFile(recapPath, "## 2026-08-22\n- first thing someone shared\n- second thing someone shared\n", "utf8");
      await repo.git.add(["-A"]);
      const second = await repo.git.commit("second sweep");

      const recap = await buildRecapBody(repo, second.commit, "https://git.dreamcatcher.inc/dreamcatcher/wiki");
      expect(recap).toBe(
        `Updated recap: [2026-08-22](https://git.dreamcatcher.inc/dreamcatcher/wiki/src/commit/${second.commit}/recaps/2026-08-22.md)`,
      );
    } finally {
      await rm(repo.dir, { recursive: true, force: true });
    }
  });

  test("rewrites a new recap file's relative wiki links into absolute permalinks, on a Forgejo/Gitea host", async () => {
    const repo = await makeRepo();
    try {
      await mkdir(join(repo.dir, "recaps"), { recursive: true });
      await mkdir(join(repo.dir, "research"), { recursive: true });
      await writeFile(join(repo.dir, "research", "gpu-kernel-optimization.md"), "# GPU kernel optimization\n", "utf8");

      const recapPath = join(repo.dir, "recaps", "2026-08-22.md");
      await writeFile(
        recapPath,
        "## 2026-08-22\n- pham shared a paper → [research/gpu-kernel-optimization.md](../research/gpu-kernel-optimization.md)\n" +
          "- see also [Source](https://discord.com/channels/1/2/3)\n",
        "utf8",
      );
      await repo.git.add(["-A"]);
      const first = await repo.git.commit("first sweep");

      const recap = await buildRecapBody(repo, first.commit, "https://git.dreamcatcher.inc/dreamcatcher/wiki");

      expect(recap).toBe(
        "## 2026-08-22\n" +
          `- pham shared a paper → [research/gpu-kernel-optimization.md](https://git.dreamcatcher.inc/dreamcatcher/wiki/src/commit/${first.commit}/research/gpu-kernel-optimization.md)\n` +
          "- see also [Source](https://discord.com/channels/1/2/3)",
      );
    } finally {
      await rm(repo.dir, { recursive: true, force: true });
    }
  });

  test("rewrites relative links using GitHub's blob path shape when the wiki is hosted there", async () => {
    const repo = await makeRepo();
    try {
      await mkdir(join(repo.dir, "recaps"), { recursive: true });
      const recapPath = join(repo.dir, "recaps", "2026-08-22.md");
      await writeFile(recapPath, "- see [people/pham.md](../people/pham.md)\n", "utf8");
      await repo.git.add(["-A"]);
      const first = await repo.git.commit("first sweep");

      const recap = await buildRecapBody(repo, first.commit, "https://github.com/sushiibot/wiki");

      expect(recap).toBe(`- see [people/pham.md](https://github.com/sushiibot/wiki/blob/${first.commit}/people/pham.md)`);
    } finally {
      await rm(repo.dir, { recursive: true, force: true });
    }
  });
});
