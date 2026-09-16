import { describe, expect, test, beforeEach } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createEmbedAttachmentTool } from "./embedTool.ts";

// pi-coding-agent's real defineTool is just an identity function (see its source) -- stubbing it
// here keeps this test from needing the ~14MB SDK import just to exercise our own tool logic.
const identityDefineTool = ((tool: unknown) => tool) as Parameters<typeof createEmbedAttachmentTool>[0];

// The typed ToolDefinition.execute signature doesn't expose isError (it's an extra field pi's
// runtime reads off the returned object), so tests go through this cast to check it directly.
interface ExecuteResult {
  details: { relativePath: string } | null;
  isError?: boolean;
}

let repoDir: string;
let inboxDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "wiki-sync-embed-repo-"));
  inboxDir = await mkdtemp(join(tmpdir(), "wiki-sync-embed-inbox-"));
});

function tool(root = inboxDir, repo = repoDir) {
  return createEmbedAttachmentTool(identityDefineTool, Type, repo, root);
}

async function run(
  t: ReturnType<typeof tool>,
  sourcePath: string,
  pagePath = "index.md",
  alt?: string,
  toolCallId = "call1",
): Promise<ExecuteResult> {
  return (await t.execute(toolCallId, { sourcePath, pagePath, alt }, undefined, undefined, {} as never)) as unknown as ExecuteResult;
}

describe("embed_attachment", () => {
  test("copies a materialized attachment into the repo and returns a page-relative path", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const result = await run(tool(), sourcePath, "index.md");

    expect(result.isError).toBeFalsy();
    const relativePath = result.details!.relativePath;
    expect(relativePath).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
    expect(existsSync(join(repoDir, relativePath))).toBe(true);
    expect(await readFile(join(repoDir, relativePath))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("dedups identical bytes to the same asset without rewriting it", async () => {
    const sourceA = join(inboxDir, "a.png");
    const sourceB = join(inboxDir, "b.png");
    await writeFile(sourceA, Buffer.from([9, 9, 9]));
    await writeFile(sourceB, Buffer.from([9, 9, 9]));

    const t = tool();
    const resultA = await run(t, sourceA, "index.md", undefined, "call1");
    const destPath = join(repoDir, "assets", resultA.details!.relativePath.split("/").pop()!);
    const statBefore = await Bun.file(destPath).stat();

    const resultB = await run(t, sourceB, "index.md", undefined, "call2");

    expect(resultB.details!.relativePath).toBe(resultA.details!.relativePath);
    // Same content hash -> same destination file; reused rather than rewritten.
    const statAfter = await Bun.file(destPath).stat();
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  test("rejects a path outside the allowed inbox root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "wiki-sync-embed-outside-"));
    const sourcePath = join(outside, "secret.txt");
    await writeFile(sourcePath, "nope");

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
  });

  test("rejects a traversal path that climbs out of the allowed root via ..", async () => {
    const sourcePath = join(inboxDir, "..", "..", "etc", "passwd");

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
  });

  test("rejects a sibling directory that merely shares the allowed root as a string prefix", async () => {
    // e.g. allowedSourceRoot=/tmp/inbox-abc, sourcePath=/tmp/inbox-abc-evil/file -- a naive
    // startsWith (without a trailing separator) would wrongly accept this.
    const sourcePath = `${inboxDir}-evil/file.txt`;

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
  });

  test("rejects a missing file", async () => {
    const sourcePath = join(inboxDir, "does-not-exist.png");

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
  });

  test("never throws out of execute even for a garbage path", async () => {
    const result = await run(tool(), "");
    expect(result.isError).toBe(true);
  });

  test("never throws out of execute when the source is a directory", async () => {
    const dirPath = join(inboxDir, "a-directory");
    await mkdir(dirPath);

    const result = await run(tool(), dirPath);

    expect(result.isError).toBe(true);
  });

  test("never throws out of execute when the source file is unreadable", async () => {
    const sourcePath = join(inboxDir, "no-read.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));
    await chmod(sourcePath, 0o000);

    try {
      const result = await run(tool(), sourcePath);
      expect(result.isError).toBe(true);
    } finally {
      await chmod(sourcePath, 0o644);
    }
  });

  test("does not write through a dangling symlink planted at the destination path", async () => {
    const sourcePath = join(inboxDir, "payload.png");
    const bytes = Buffer.from([7, 7, 7, 7]);
    await writeFile(sourcePath, bytes);

    // Compute the destination hash the tool will use, then pre-plant a dangling symlink there
    // pointing at a file outside the repo -- simulating a symlink committed to the wiki and
    // recreated by `git reset --hard` each sweep.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const assetsDir = join(repoDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const evilTarget = join(await mkdtemp(join(tmpdir(), "wiki-sync-embed-evil-")), "pwned");
    const destPath = join(assetsDir, `${hash}.png`);
    await symlink(evilTarget, destPath);

    const result = await run(tool(), sourcePath);

    // The call must not write the attachment bytes through the symlink to evilTarget.
    expect(existsSync(evilTarget)).toBe(false);
    // The planted symlink itself must survive untouched -- wx never clobbers or follows it.
    expect((await lstat(destPath)).isSymbolicLink()).toBe(true);
    // A symlink occupant is NOT a valid dedup hit -- the tool must refuse, not vouch for a link
    // that resolves to unintended/broken content.
    expect(result.isError).toBe(true);
  });

  test("refuses when destPath is a symlink to an existing file (alias), not just a dangling one", async () => {
    const sourcePath = join(inboxDir, "payload.png");
    const bytes = Buffer.from([5, 5, 5, 5]);
    await writeFile(sourcePath, bytes);

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const assetsDir = join(repoDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const aliasTarget = join(await mkdtemp(join(tmpdir(), "wiki-sync-embed-alias-")), "other");
    await writeFile(aliasTarget, Buffer.from("UNRELATED CONTENT"));
    const destPath = join(assetsDir, `${hash}.png`);
    await symlink(aliasTarget, destPath);

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
    // Alias target untouched, symlink survives.
    expect((await readFile(aliasTarget)).toString()).toBe("UNRELATED CONTENT");
    expect((await lstat(destPath)).isSymbolicLink()).toBe(true);
  });

  test("refuses when destPath already holds a regular file with different content (collision/tampering)", async () => {
    const sourcePath = join(inboxDir, "payload.png");
    const bytes = Buffer.from([9, 8, 7, 6]);
    await writeFile(sourcePath, bytes);

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const assetsDir = join(repoDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const destPath = join(assetsDir, `${hash}.png`);
    await writeFile(destPath, Buffer.from("DIFFERENT BYTES AT SAME HASH PATH"));

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
    // The pre-existing file is left as-is (never overwritten).
    expect((await readFile(destPath)).toString()).toBe("DIFFERENT BYTES AT SAME HASH PATH");
  });

  test("dedups when destPath already holds a regular file with identical content", async () => {
    const sourcePath = join(inboxDir, "payload.png");
    const bytes = Buffer.from([4, 4, 4, 4]);
    await writeFile(sourcePath, bytes);

    // First embed writes the asset; second identical embed must succeed as a dedup hit.
    const first = await run(tool(), sourcePath, "index.md");
    expect(first.isError).toBeFalsy();
    const second = await run(tool(), sourcePath, "index.md");
    expect(second.isError).toBeFalsy();
    expect(second.details?.relativePath).toBe(first.details?.relativePath);
  });

  test("refuses when the assets directory is a symlink pointing outside the repo", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));

    const outsideDir = await mkdtemp(join(tmpdir(), "wiki-sync-embed-outside-assets-"));
    await symlink(outsideDir, join(repoDir, "assets"));

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBe(true);
    expect(existsSync(join(outsideDir))).toBe(true);
    const outsideEntries = await import("node:fs/promises").then((m) => m.readdir(outsideDir));
    expect(outsideEntries.length).toBe(0);
  });

  test("returns a page-relative link with ../ for a page in a subdirectory", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));
    await mkdir(join(repoDir, "people"), { recursive: true });

    const result = await run(tool(), sourcePath, "people/tzushi.md");

    expect(result.isError).toBeFalsy();
    expect(result.details!.relativePath).toMatch(/^\.\.\/assets\/[0-9a-f]{16}\.png$/);
  });

  test("returns a root-relative link for a root-level page", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));

    const result = await run(tool(), sourcePath, "index.md");

    expect(result.isError).toBeFalsy();
    expect(result.details!.relativePath).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
  });

  test("rejects a pagePath that resolves outside the repo", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));

    const result = await run(tool(), sourcePath, "../../etc/passwd");

    expect(result.isError).toBe(true);
  });

  test("rejects a pagePath of the repo root itself (empty or dot)", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));

    const resultEmpty = await run(tool(), sourcePath, "", undefined, "call1");
    const resultDot = await run(tool(), sourcePath, ".", undefined, "call2");

    expect(resultEmpty.isError).toBe(true);
    expect(resultDot.isError).toBe(true);
  });

  test("falls back to .bin for a source file with no usable extension", async () => {
    const sourcePath = join(inboxDir, "noextension");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));

    const result = await run(tool(), sourcePath);

    expect(result.isError).toBeFalsy();
    expect(result.details!.relativePath).toMatch(/^assets\/[0-9a-f]{16}\.bin$/);
  });
});
