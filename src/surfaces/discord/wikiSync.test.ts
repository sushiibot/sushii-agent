import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import type { Replacement } from "../../modules/wiki-sync/context.ts";
import { createDiscordWikiSyncContext, makeDiscordWikiSyncContext } from "./wikiSync.ts";

function msg(overrides: Partial<WikiSyncMessage> = {}): WikiSyncMessage {
  return {
    surface: "discord",
    spaceId: "g1",
    messageId: "42",
    channelId: "c1",
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

/** A client that records whether `channels.fetch` was hit, so a test can assert no live refetch. */
function trackingClient(): { client: Client; fetches: string[] } {
  const fetches: string[] = [];
  const client = {
    channels: {
      fetch: async (id: string) => {
        fetches.push(id);
        return null;
      },
      cache: { get: () => undefined },
    },
  } as unknown as Client;
  return { client, fetches };
}

describe("createDiscordWikiSyncContext", () => {
  test("linkFor builds the discord.com URL from the message's spaceId/channelId/messageId", () => {
    const { client } = trackingClient();
    const ctx = createDiscordWikiSyncContext(client, { surface: "discord", spaceId: "g9" });
    expect(ctx.linkFor(msg({ spaceId: "g9", channelId: "c7", messageId: "88" }))).toBe(
      "https://discord.com/channels/g9/c7/88",
    );
  });

  test("attachmentsFor returns [] without a live refetch when content has no CDN marker", async () => {
    const { client, fetches } = trackingClient();
    const ctx = createDiscordWikiSyncContext(client, { surface: "discord", spaceId: "g1" });
    const result = await ctx.attachments.attachmentsFor(msg({ content: "just text, no attachments" }));
    expect(result).toEqual([]);
    expect(fetches).toEqual([]);
  });

  test("rewriteAttachmentLinks relocates a CDN label to its materialized local path by attachment id", () => {
    const { client } = trackingClient();
    const ctx = createDiscordWikiSyncContext(client, { surface: "discord", spaceId: "g1" });
    const content = "[image: foo.png](https://cdn.discordapp.com/attachments/999/1111/foo.png?ex=abc)";
    const replacements = new Map<string, Replacement>([["1111", { url: "/local/foo.png" }]]);
    expect(ctx.attachments.rewriteAttachmentLinks(content, replacements)).toBe("[image: foo.png](/local/foo.png)");
  });
});

describe("makeDiscordWikiSyncContext", () => {
  test("returns null for a non-discord source surface", () => {
    const { client } = trackingClient();
    expect(makeDiscordWikiSyncContext(client, "w1", { surface: "slack", spaceId: "T1" })).toBeNull();
  });

  test("builds a context for a discord source", () => {
    const { client } = trackingClient();
    expect(makeDiscordWikiSyncContext(client, "w1", { surface: "discord", spaceId: "g1" })).not.toBeNull();
  });
});
