import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config.ts";
import type { WikiSyncContext } from "./context.ts";
import type { WikiSource } from "./sources.ts";

// Stub the two heavy, side-effecting deps so a sweep can run without a real git remote or Pi model.
// The real exports are spread back in so other modules/tests importing these keep working (the mock
// registry is process-wide): only `openWikiRepo`/`runWikiSyncSession` are overridden.
import * as realGit from "./git.ts";
import * as realPiSession from "./piSession.ts";

mock.module("./git.ts", () => ({
  ...realGit,
  openWikiRepo: async () => ({ dir: "/tmp/wiki-sync-test-repo", git: {} }),
}));
mock.module("./piSession.ts", () => ({
  ...realPiSession,
  runWikiSyncSession: async () => ({ finalText: "", commitSha: null }),
}));

const { getDb, initDb, closeDb } = await import("../../db/index.ts");
const { getWikiSyncWatermark } = await import("../../db/wikiSync.ts");
const { runWikiSyncSweep } = await import("./sweep.ts");

const saved = {
  guildConfig: config.guildConfig,
  teams: config.teams,
  inboxDir: config.wikiSync.inboxDir,
  databasePath: config.databasePath,
};

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wiki-sync-sweep-test-"));
  config.databasePath = join(tmp, "test.db");
  config.wikiSync.inboxDir = join(tmp, "inbox");
  await initDb();
});

afterAll(async () => {
  closeDb();
  config.guildConfig = saved.guildConfig;
  config.teams = saved.teams;
  config.wikiSync.inboxDir = saved.inboxDir;
  config.databasePath = saved.databasePath;
  await rm(tmp, { recursive: true, force: true });
});

afterEach(() => {
  config.guildConfig = saved.guildConfig;
  config.teams = saved.teams;
});

function contextFor(source: WikiSource, createdAt: number): WikiSyncContext {
  return {
    messages: {
      fetchUnprocessed: () => [
        {
          surface: source.surface,
          spaceId: source.spaceId,
          messageId: `m-${source.spaceId}`,
          channelId: "c1",
          parentChannelId: null,
          authorId: "u1",
          authorUsername: "someuser",
          authorDisplayName: null,
          content: "hello",
          createdAt,
          replyTo: null,
        },
      ],
    },
    channelNames: { resolve: () => null },
    attachments: { attachmentsFor: async () => [], rewriteAttachmentLinks: (c) => c },
    linkFor: () => "test://link",
    notify: { postStatus: async () => {} },
  };
}

describe("runWikiSyncSweep (multi-source)", () => {
  test("advances each source's watermark independently to its own last message", async () => {
    config.guildConfig = {};
    config.teams = {
      w1team: {
        wiki: { wikiId: "w1" },
        spaces: [
          { surface: "discord", spaceId: "a", wiki: "source" },
          { surface: "discord", spaceId: "b", wiki: "source" },
        ],
      },
    };

    const createdAt: Record<string, number> = { a: 1000, b: 2000 };
    const result = await runWikiSyncSweep("w1", (source) => contextFor(source, createdAt[source.spaceId]!));

    expect(result.ran).toBe(true);
    expect(result.sources.map((s) => s.spaceId)).toEqual(["a", "b"]);

    const db = getDb();
    expect(getWikiSyncWatermark(db, "w1", "discord", "a")).toBe(1000);
    expect(getWikiSyncWatermark(db, "w1", "discord", "b")).toBe(2000);
  });
});
