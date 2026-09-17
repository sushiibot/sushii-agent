import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepInRoot, listInRoot, readInRoot, resolveInRoot } from "./scopedFs.ts";

// grepInRoot shells out to ripgrep (installed in the container; see Dockerfile). Skip the grep case
// on a dev box without it, like the poppler-gated attachment tests.
const RG_AVAILABLE = Bun.which("rg") !== null;
const itIfRg = test.skipIf(!RG_AVAILABLE);
if (!RG_AVAILABLE) console.warn("ripgrep not found on PATH — skipping grepInRoot test");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scoped-fs-test-"));
  await mkdir(join(dir, "people"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, "people", "alice.md"), "# Alice\n\nAlice moderates the art channel.");
  await writeFile(join(dir, "readme.md"), "Welcome. Topics include raids and spam.");
  await writeFile(join(dir, ".git", "secret.md"), "should be ignored under .git");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveInRoot", () => {
  test("rejects path traversal outside the root", () => {
    expect(resolveInRoot(dir, "../../etc/passwd")).toBeNull();
    expect(resolveInRoot(dir, "people/alice.md")).toBe(join(dir, "people", "alice.md"));
  });
});

describe("listInRoot", () => {
  test("lists one level with directories suffixed '/', skips .git", async () => {
    const top = await listInRoot(dir);
    const paths = top!.map((e) => e.path);
    expect(paths).toContain("people/");
    expect(paths).toContain("readme.md");
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
  });

  test("lists a subdirectory and returns null for one outside the root", async () => {
    expect((await listInRoot(dir, "people"))!.map((e) => e.path)).toEqual(["people/alice.md"]);
    expect(await listInRoot(dir, "../..")).toBeNull();
  });
});

describe("readInRoot", () => {
  test("reads a file, and rejects traversal / missing", async () => {
    expect(await readInRoot(dir, "people/alice.md")).toContain("moderates the art channel");
    expect(await readInRoot(dir, "../../../etc/passwd")).toBeNull();
    expect(await readInRoot(dir, "missing.md")).toBeNull();
  });
});

describe("grepInRoot", () => {
  itIfRg("returns matching lines with file + line number, skipping .git", async () => {
    const matches = await grepInRoot(dir, "raid");
    expect(matches.map((m) => m.path)).toContain("readme.md");
    const hit = matches.find((m) => m.path === "readme.md")!;
    expect(hit.line).toBeGreaterThan(0);
    expect(hit.text.toLowerCase()).toContain("raid");
    expect(matches.some((m) => m.path.startsWith(".git"))).toBe(false);
  });

  itIfRg("returns nothing for an unresolvable root", async () => {
    expect(await grepInRoot(join(dir, "nope"), "anything")).toEqual([]);
  });
});
