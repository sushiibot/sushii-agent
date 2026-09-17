import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWikiPage, searchWikiPages } from "./search.ts";

// searchWikiPages shells out to ripgrep (installed in the container; see Dockerfile). Skip the
// search cases on a dev box without it, like the poppler-gated attachment tests.
const RG_AVAILABLE = Bun.which("rg") !== null;
const itIfRg = test.skipIf(!RG_AVAILABLE);
if (!RG_AVAILABLE) console.warn("ripgrep not found on PATH — skipping wiki search tests");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wiki-search-test-"));
  await mkdir(join(dir, "people"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, "people", "alice.md"), "# Alice\n\nAlice is a long-time member who moderates the art channel.");
  await mkdir(join(dir, "topics"), { recursive: true });
  await writeFile(join(dir, "topics", "raids.md"), "# Raid response\n\nWhen a raid happens, lock the channel and alert mods.");
  await writeFile(join(dir, ".git", "config.md"), "# should be ignored under .git");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("searchWikiPages", () => {
  itIfRg("finds a page by a content term and returns a snippet", async () => {
    const hits = await searchWikiPages(dir, "raid");
    expect(hits.map((h) => h.path)).toContain("topics/raids.md");
    expect(hits.find((h) => h.path === "topics/raids.md")!.snippet.toLowerCase()).toContain("raid");
  });

  itIfRg("ranks a title/path match above an incidental body mention", async () => {
    await writeFile(join(dir, "misc.md"), "Alice was mentioned here once, otherwise about gardening.");
    const hits = await searchWikiPages(dir, "alice");
    expect(hits[0].path).toBe("people/alice.md"); // titled/pathed for alice, outranks misc.md
  });

  itIfRg("a multi-term query requires every term to appear somewhere", async () => {
    // "raid" is in raids.md but "gardening" is not — so no page should match both.
    const hits = await searchWikiPages(dir, "raid gardening");
    expect(hits).toHaveLength(0);
  });

  itIfRg("ignores files under .git and returns empty for an unresolvable dir", async () => {
    const all = await searchWikiPages(dir, "ignored");
    expect(all.every((h) => !h.path.startsWith(".git"))).toBe(true);
    expect(await searchWikiPages(join(dir, "does-not-exist"), "anything")).toEqual([]);
  });
});

describe("readWikiPage", () => {
  test("reads a page by repo-relative path", async () => {
    expect(await readWikiPage(dir, "people/alice.md")).toContain("moderates the art channel");
  });

  test("rejects path traversal and non-markdown paths", async () => {
    expect(await readWikiPage(dir, "../../../etc/passwd")).toBeNull();
    expect(await readWikiPage(dir, "people/alice.txt")).toBeNull();
    expect(await readWikiPage(dir, "missing.md")).toBeNull();
  });
});
