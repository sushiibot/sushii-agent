import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function tool(root = inboxDir) {
  return createEmbedAttachmentTool(identityDefineTool, Type, repoDir, root);
}

async function run(t: ReturnType<typeof tool>, sourcePath: string, toolCallId = "call1"): Promise<ExecuteResult> {
  return (await t.execute(toolCallId, { sourcePath }, undefined, undefined, {} as never)) as unknown as ExecuteResult;
}

describe("embed_attachment", () => {
  test("copies a materialized attachment into the repo and returns its repo-relative path", async () => {
    const sourcePath = join(inboxDir, "foo.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const result = await run(tool(), sourcePath);

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
    const resultA = await run(t, sourceA, "call1");
    const destPath = join(repoDir, resultA.details!.relativePath);
    const statBefore = await Bun.file(destPath).stat();

    const resultB = await run(t, sourceB, "call2");

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
});
