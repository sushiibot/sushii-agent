import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import { writeMessageInbox } from "./inbox.ts";

function msg(overrides: Partial<WikiSyncMessage> = {}): WikiSyncMessage {
  return {
    surface: "discord",
    spaceId: "g1",
    messageId: "1",
    channelId: "chan1",
    parentChannelId: null,
    authorId: "u1",
    authorUsername: "someuser",
    authorDisplayName: null,
    content: "hello",
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    replyTo: null,
    ...overrides,
  };
}

// A synthetic linkFor (not the real discord.com shape) so these assertions test the inbox's own
// use of the port, not a laundered copy of the Discord URL builder — that lives in the Discord
// surface's own test.
function fakeDeps(names: Record<string, string>) {
  return {
    channelNames: { resolve: (id: string) => names[id] ?? null },
    attachments: { attachmentsFor: async () => [], rewriteAttachmentLinks: (c: string) => c },
    linkFor: (m: WikiSyncMessage) => `test://${m.spaceId}/${m.channelId}/${m.messageId}`,
  };
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
    const deps = fakeDeps({ c1: "general", c2: "support" });
    const { files } = await writeMessageInbox(
      dir,
      deps,
      [msg({ channelId: "c1" }), msg({ channelId: "c2" }), msg({ channelId: "c1" })],
    );
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(existsSync(f.path)).toBe(true);
    }
  });

  test("uses a slugified channel name plus id when the channel resolves", async () => {
    const deps = fakeDeps({ c1: "General Chat!" });
    const { files } = await writeMessageInbox(dir, deps, [msg({ channelId: "c1" })]);
    expect(files[0]!.path).toBe(join(dir, "general-chat-c1.md"));
  });

  test("falls back to the raw channel id when the channel doesn't resolve", async () => {
    const deps = fakeDeps({});
    const { files } = await writeMessageInbox(dir, deps, [msg({ channelId: "unknown-chan" })]);
    expect(files[0]!.path).toBe(join(dir, "unknown-chan.md"));
  });

  test("file content includes timestamp, author, and message text", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(
      dir,
      deps,
      [msg({ channelId: "c1", authorUsername: "alice", content: "hello world" })],
    );
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain("alice");
    expect(content).toContain("hello world");
    expect(content).toContain("2026-01-01");
  });

  test("includes the message's source permalink (via linkFor) so the model can cite it", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(dir, deps, [msg({ channelId: "c1", messageId: "42" })]);
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain("(test://g1/c1/42)");
  });

  test("includes the author's Discord id, the only stable cross-reference since the inbox is wiped every sweep", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(dir, deps, [msg({ channelId: "c1", authorId: "429779375072870400" })]);
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain("(id 429779375072870400)");
  });

  test("clears a previous batch before writing the new one", async () => {
    const deps = fakeDeps({ c1: "general" });
    await writeMessageInbox(dir, deps, [msg({ channelId: "c1" }), msg({ channelId: "stale-chan" })]);
    const { files } = await writeMessageInbox(dir, deps, [msg({ channelId: "c1" })]);
    expect(files.map((f) => f.path)).toEqual([join(dir, "general-c1.md")]);
    expect(existsSync(join(dir, "stale-chan.md"))).toBe(false);
  });

  test("returns each file's channelId and parentChannelId so a caller can classify files without re-deriving the filename scheme", async () => {
    const deps = fakeDeps({ c1: "general", "thread-1": "bug: login broken" });
    const { files } = await writeMessageInbox(
      dir,
      deps,
      [msg({ channelId: "c1" }), msg({ channelId: "thread-1", parentChannelId: "c1" })],
    );
    const byChannel = new Map(files.map((f) => [f.channelId, f]));
    expect(byChannel.get("c1")).toMatchObject({ channelId: "c1", parentChannelId: null });
    expect(byChannel.get("thread-1")).toMatchObject({ channelId: "thread-1", parentChannelId: "c1" });
  });

  test("a thread's file name and header reference its parent channel", async () => {
    const deps = fakeDeps({ "thread-1": "bug: login broken", "general": "general" });
    const { files } = await writeMessageInbox(
      dir,
      deps,
      [msg({ channelId: "thread-1", parentChannelId: "general" })],
    );
    expect(files[0]!.path).toBe(join(dir, "general--bug-login-broken-thread-1.md"));
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain('Thread "bug: login broken" in #general');
  });

  test("a thread with an unresolvable parent still labels it by id", async () => {
    const deps = fakeDeps({ "thread-1": "some thread" });
    const { files } = await writeMessageInbox(
      dir,
      deps,
      [msg({ channelId: "thread-1", parentChannelId: "unknown-parent" })],
    );
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain("channel unknown-parent");
  });

  test("a non-thread channel gets a plain channel header, no thread language", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(dir, deps, [msg({ channelId: "c1" })]);
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain("# #general");
    expect(content).not.toContain("Thread");
  });

  test("a reply is annotated inline with who and what it replied to", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(
      dir,
      deps,
      [msg({ channelId: "c1", content: "totally agree", replyTo: { author: "pham", content: "is this still broken?" } })],
    );
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).toContain('replying to pham ("is this still broken?")');
    expect(content).toContain("totally agree");
  });

  test("consecutive messages from the same author collapse into one header with plain content lines", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(dir, deps, [
      msg({ channelId: "c1", messageId: "1", authorId: "u1", content: "first" }),
      msg({ channelId: "c1", messageId: "2", authorId: "u1", content: "second" }),
      msg({ channelId: "c1", messageId: "3", authorId: "u1", content: "third" }),
    ]);
    const content = await readFile(files[0]!.path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.filter((l) => l.includes("someuser"))).toHaveLength(1);
    expect(content).toContain("sent 3 messages in a row");
    expect(content).toContain("(test://g1/c1/1)");
    expect(lines).toContain("first");
    expect(lines).toContain("second");
    expect(lines).toContain("third");
  });

  test("a message from a different author, or a reply, breaks the run instead of merging", async () => {
    const deps = fakeDeps({ c1: "general" });
    const { files } = await writeMessageInbox(dir, deps, [
      msg({ channelId: "c1", messageId: "1", authorId: "u1", content: "hi" }),
      msg({ channelId: "c1", messageId: "2", authorId: "u2", content: "hey" }),
      msg({
        channelId: "c1",
        messageId: "3",
        authorId: "u2",
        content: "reply here",
        replyTo: { author: "someuser", content: "hi" },
      }),
    ]);
    const content = await readFile(files[0]!.path, "utf8");
    expect(content).not.toContain("in a row");
    expect(content).toContain("(test://g1/c1/1)");
    expect(content).toContain("(test://g1/c1/2)");
    expect(content).toContain("(test://g1/c1/3)");
  });
});
