import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import { writeMessageInbox } from "./inbox.ts";

function msg(overrides: Partial<WikiSyncMessage> = {}): WikiSyncMessage {
  return {
    discordId: "1",
    channelId: "chan1",
    authorId: "u1",
    authorUsername: "someuser",
    authorDisplayName: null,
    content: "hello",
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeClient(names: Record<string, string>) {
  return {
    channels: {
      cache: {
        get: (id: string) => (names[id] ? { name: names[id] } : undefined),
      },
    },
  } as unknown as import("discord.js").Client;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wiki-sync-inbox-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeMessageInbox", () => {
  test("writes one file per channel directly into the given directory", async () => {
    const client = fakeClient({ c1: "general", c2: "support" });
    const { files } = await writeMessageInbox(
      dir,
      client,
      [msg({ channelId: "c1" }), msg({ channelId: "c2" }), msg({ channelId: "c1" })],
    );
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(existsSync(f)).toBe(true);
    }
  });

  test("uses a slugified channel name plus id when the channel resolves", async () => {
    const client = fakeClient({ c1: "General Chat!" });
    const { files } = await writeMessageInbox(dir, client, [msg({ channelId: "c1" })]);
    expect(files[0]).toBe(join(dir, "general-chat-c1.md"));
  });

  test("falls back to the raw channel id when the channel doesn't resolve", async () => {
    const client = fakeClient({});
    const { files } = await writeMessageInbox(dir, client, [msg({ channelId: "unknown-chan" })]);
    expect(files[0]).toBe(join(dir, "unknown-chan.md"));
  });

  test("file content includes timestamp, author, and message text", async () => {
    const client = fakeClient({ c1: "general" });
    const { files } = await writeMessageInbox(
      dir,
      client,
      [msg({ channelId: "c1", authorUsername: "alice", content: "hello world" })],
    );
    const content = await readFile(files[0]!, "utf8");
    expect(content).toContain("alice");
    expect(content).toContain("hello world");
    expect(content).toContain("2026-01-01");
  });

  test("clears a previous batch before writing the new one", async () => {
    const client = fakeClient({ c1: "general" });
    await writeMessageInbox(dir, client, [msg({ channelId: "c1" }), msg({ channelId: "stale-chan" })]);
    const { files } = await writeMessageInbox(dir, client, [msg({ channelId: "c1" })]);
    expect(files).toEqual([join(dir, "general-c1.md")]);
    expect(existsSync(join(dir, "stale-chan.md"))).toBe(false);
  });
});
