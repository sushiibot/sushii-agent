import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryHandlers } from "./memoryFiles.ts";
import { memoryDetail, memoryOverview, MEMORY_FILE_MAX } from "../orchestration/memoryContracts.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "memory-browser-"));
  roots.push(home);
  await mkdir(join(home, "memory"));
  return {
    home,
    read: memoryHandlers({ home, principalId: "owner" })["memory/read"],
  };
}
test("lists real long-term and daily files and reads an opaque id", async () => {
  const { home, read } = await setup();
  await writeFile(join(home, "MEMORY.md"), "# Facts\nKeep this");
  await writeFile(join(home, "memory/2026-10-02.md"), "# Today");
  await writeFile(join(home, "private.txt"), "private");
  const overview = memoryOverview.parse(await read({ principalId: "owner" }));
  expect(overview.files.map((f) => f.path)).toEqual(["MEMORY.md", "memory/2026-10-02.md"]);
  const detail = memoryDetail.parse(await read({ principalId: "owner", id: overview.files[0]!.id }));
  expect(detail?.file.content).toBe("# Facts\nKeep this");
  await expect(read({ principalId: "other" })).rejects.toThrow("principal");
  expect(
    await read({
      principalId: "owner",
      id: Buffer.from("../private.txt").toString("base64url"),
    }),
  ).toBeNull();
});
test("refuses symlinks and hardlinks including symlinked parent directories", async () => {
  const { home, read } = await setup();
  await writeFile(join(home, "private.md"), "secret");
  await symlink(join(home, "private.md"), join(home, "USER.md"));
  await link(join(home, "private.md"), join(home, "MEMORY.md"));
  await mkdir(join(home, "elsewhere"));
  await writeFile(join(home, "elsewhere/note.md"), "outside");
  await symlink(join(home, "elsewhere"), join(home, "memory/sub"));
  expect(memoryOverview.parse(await read({ principalId: "owner" })).files).toEqual([]);
  expect(
    await read({
      principalId: "owner",
      id: Buffer.from("memory/sub/note.md").toString("base64url"),
    }),
  ).toBeNull();
});
test("large contents are explicitly truncated", async () => {
  const { home, read } = await setup();
  await writeFile(join(home, "MEMORY.md"), "x".repeat(MEMORY_FILE_MAX + 5));
  const overview = memoryOverview.parse(await read({ principalId: "owner" }));
  expect(overview.truncated).toBe(true);
  const detail = memoryDetail.parse(await read({ principalId: "owner", id: overview.files[0]!.id }));
  expect(detail?.file.truncated).toBe(true);
  expect(detail?.file.content.length).toBe(MEMORY_FILE_MAX);
});

test("catalog and topic documents are browsable through the existing memory API", async () => {
  const { home, read } = await setup();
  await mkdir(join(home, "memory/topics"));
  await writeFile(join(home, "memory/catalog.md"), "map");
  await writeFile(join(home, "memory/topics/backend.md"), "# Backend\nverified: unverified\n");
  const overview = memoryOverview.parse(await read({ principalId: "owner" }));
  expect(overview.files.map((f) => [f.path, f.about])).toEqual([
    ["memory/catalog.md", "Map of durable topic notes"],
    ["memory/topics/backend.md", "Durable decisions and reference notes"],
  ]);
  const detail = memoryDetail.parse(await read({ principalId: "owner", id: overview.files[1]!.id }));
  expect(detail?.file.content).toContain("verified: unverified");
});
