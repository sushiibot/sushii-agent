import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionBoundaryRecorder } from "./sessionBoundary.ts";
import { SESSION_TEXT_MAX, sessionBoundary } from "../orchestration/sessionContracts.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "boundary-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, "memory"), { recursive: true });
  await writeFile(join(home, "USER.md"), "Old preferences.");
  await writeFile(join(home, "MEMORY.md"), "Old facts.");
  return { root, home };
}

test("captures changed, added and removed files and persists an independent baseline per conversation", async () => {
  const { root, home } = await setup();
  const main = new SessionBoundaryRecorder(home, join(root, "main"));
  const topic = new SessionBoundaryRecorder(home, join(root, "topic"));
  await main.initialize();
  await topic.initialize();
  await writeFile(join(home, "USER.md"), "New preferences and decisions.");
  await writeFile(join(home, "memory/topic.md"), "A new topic decision.");
  await rm(join(home, "MEMORY.md"));
  const loaded = [{ path: "USER.md", content: "Actually loaded preferences." }];
  const first = await main.capture(loaded);
  expect(first.memory?.files.map(f => [f.path, f.change])).toEqual([["USER.md", "changed"], ["memory/topic.md", "added"], ["MEMORY.md", "removed"]]);
  expect(first.context?.files[0]?.content).toBe("Actually loaded preferences.");
  const restored = new SessionBoundaryRecorder(home, join(root, "main"));
  await restored.initialize();
  expect((await restored.capture(loaded)).memory?.files).toEqual([]);
  expect((await topic.capture(loaded)).memory?.files).toEqual(first.memory?.files);
  expect(first.memory?.files[0]?.content).toBe("New preferences and decisions.");
});

test("bounds previews and excludes symlinked memory files", async () => {
  const { root, home } = await setup();
  const recorder = new SessionBoundaryRecorder(home, join(root, "state"));
  await recorder.initialize();
  await writeFile(join(home, "private.md"), "not memory");
  await symlink(join(home, "private.md"), join(home, "memory/link.md"));
  await writeFile(join(home, "memory/long.md"), "x".repeat(SESSION_TEXT_MAX + 10));
  const detail = await recorder.capture([{ path: "MEMORY.md", content: "y".repeat(SESSION_TEXT_MAX + 10) }]);
  expect(detail.memory?.files).toHaveLength(1);
  expect(detail.memory?.files[0]).toMatchObject({ path: "memory/long.md", truncated: true });
  expect(detail.context?.files[0]?.truncated).toBe(true);
  expect(sessionBoundary.safeParse({ kind: "compacted", ...detail }).success).toBe(true);
});
