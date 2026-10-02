import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableInbox } from "./durableInbox.ts";
import { DurableState } from "../agentRuntime/durableState.ts";

const roots: string[] = [];
const opened: DurableInbox[] = [];
const stores: DurableState[] = [];
afterEach(async () => {
  for (const inbox of opened.splice(0)) await inbox.close();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dir() {
  const path = mkdtempSync(join(tmpdir(), "sushii-durable-inbox-"));
  roots.push(path);
  return path;
}
async function open(path: string, capacity = 500) {
  const inbox = new DurableInbox(path, capacity);
  await inbox.open();
  opened.push(inbox);
  return inbox;
}
async function close(inbox: DurableInbox) {
  await inbox.close();
  opened.splice(opened.indexOf(inbox), 1);
}

test("queued inputs keep their order, origin, and image bytes after reopening SQLite", async () => {
  const path = dir();
  const inbox = await open(path);
  const first = { messageId: "m1", text: "an earlier input", origin: { surface: "discord", conversationId: "dm" } };
  const second = { messageId: "m2", text: "a steer", images: [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }] };
  for (const input of [first, second]) {
    await inbox.prepare(input);
    inbox.add(input.messageId);
  }
  await close(inbox);
  const restarted = await open(path);
  expect(await restarted.pending()).toEqual([first, second]);
  expect(restarted.has("m1")).toBe(true);
  // Re-preparing a stranded steer updates it without moving it or creating a duplicate.
  await restarted.prepare({ ...first, text: "updated" });
  expect((await restarted.pending()).map((p) => p.messageId)).toEqual(["m1", "m2"]);
});

test("consumed and explicitly dropped inputs keep receipts but never replay", async () => {
  const path = dir();
  const inbox = await open(path);
  await inbox.prepare({ messageId: "consumed", text: "work with side effects" });
  // Consumption and the receipt commit together, even before the caller receives acceptance.
  inbox.consume(["consumed"]);
  await close(inbox);
  const restarted = await open(path);
  expect(await restarted.pending()).toEqual([]);
  expect(restarted.has("consumed")).toBe(true);
});

test("legacy deduplication receipts migrate once and pending inputs survive receipt eviction", async () => {
  const path = dir();
  writeFileSync(join(path, "recent-ids.json"), JSON.stringify(["old", "latest"]));
  const inbox = await open(path, 2);
  expect(inbox.has("latest")).toBe(true);
  await inbox.prepare({ messageId: "queued", text: "do not lose me" });
  for (const id of ["queued", "new-1", "new-2"]) inbox.add(id);
  await close(inbox);
  writeFileSync(join(path, "recent-ids.json"), JSON.stringify(["stale"]));
  const restarted = await open(path, 2);
  expect(restarted.has("queued")).toBe(true);
  expect(restarted.has("old")).toBe(false);
  expect(restarted.has("stale")).toBe(false);
  expect(restarted.has("new-2")).toBe(true);
});

test("a checkpoint survives SIGKILL without closing the SQLite connection", async () => {
  const path = dir();
  const childFile = join(path, "crash.ts");
  writeFileSync(childFile, `
    import { DurableInbox } from ${JSON.stringify(import.meta.resolve("./durableInbox.ts"))};
    const inbox = new DurableInbox(${JSON.stringify(path)});
    await inbox.open();
    await inbox.prepare({ messageId: "crash-input", text: "survive the process dying" });
    inbox.add("crash-input");
    await inbox.flush();
    console.log("checkpoint saved");
    setInterval(() => {}, 1000);
  `);
  const child = Bun.spawn([process.execPath, "--no-env-file", childFile], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("checkpoint saved");
    reader.releaseLock();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const restarted = await open(path);
  expect(await restarted.pending()).toEqual([{ messageId: "crash-input", text: "survive the process dying" }]);
  expect(restarted.has("crash-input")).toBe(true);
});

test("an unreadable database fails admission instead of silently discarding the inbox", async () => {
  const path = dir();
  writeFileSync(join(path, "workspace.sqlite"), "not a SQLite database");
  const inbox = new DurableInbox(path);
  await expect(inbox.open()).rejects.toThrow();
});

test("main and topics share one database with independent receipts and queued inputs", async () => {
  const path = dir();
  const topicDir = join(path, "topics", "topic-1");
  const store = new DurableState(path);
  stores.push(store);
  const main = new DurableInbox(path, 500, { store, conversationId: "main" });
  const topic = new DurableInbox(topicDir, 500, { store, conversationId: "topic-1" });
  opened.push(main, topic);
  await Promise.all([main.open(), topic.open()]);
  await Promise.all([
    main.prepare({ messageId: "same-id", text: "main input" }),
    topic.prepare({ messageId: "same-id", text: "topic input" }),
  ]);
  main.add("same-id");
  topic.add("same-id");
  main.consume(["same-id"]);
  await close(main);
  expect(await topic.pending()).toEqual([{ messageId: "same-id", text: "topic input" }]);
  expect(topic.has("same-id")).toBe(true);
  // Disposing a conversation cannot close the database another conversation uses.
  await topic.prepare({ messageId: "later", text: "still open" });
  expect(existsSync(join(path, "workspace.sqlite"))).toBe(true);
  expect(existsSync(join(topicDir, "workspace.sqlite"))).toBe(false);
  await close(topic);
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new DurableState(path);
  stores.push(reopened);
  const restored = new DurableInbox(topicDir, 500, { store: reopened, conversationId: "topic-1" });
  opened.push(restored);
  await restored.open();
  expect((await restored.pending()).map((p) => p.text)).toEqual(["topic input", "still open"]);
});
