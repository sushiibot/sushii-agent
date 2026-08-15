import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpFetch, mcpSearch, mcpSend } from "./tools.ts";
import type { McpSession } from "./session.ts";
import type { WebhookCache } from "./webhooks.ts";

const session: McpSession = {
  identity: { id: "u1", username: "alice", avatar: null },
  permittedGuildIds: ["guildA"],
};

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected a text content block");
  return block.text;
}

function fakeClient(channelGuildId: string | null): Client<true> {
  return {
    channels: {
      fetch: async (_id: string) => {
        if (channelGuildId === null) return null;
        return {
          isTextBased: () => true,
          isDMBased: () => false,
          guildId: channelGuildId,
        };
      },
    },
  } as unknown as Client<true>;
}

describe("mcpFetch", () => {
  test("rejects a channel outside the caller's permitted guilds", async () => {
    const client = fakeClient("guildB");
    let called = false;
    const fetchFn = async () => {
      called = true;
      return [];
    };
    const result = await mcpFetch(client, session, { channel_id: "c1" }, fetchFn as never);
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  test("succeeds for a channel inside the caller's permitted guilds", async () => {
    const client = fakeClient("guildA");
    let calledWithGuildId: string | undefined;
    const fetchFn = async (args: { guildId: string }) => {
      calledWithGuildId = args.guildId;
      return [{ discord_id: "m1" }] as never;
    };
    const result = await mcpFetch(client, session, { channel_id: "c1" }, fetchFn as never);
    expect(result.isError).toBeUndefined();
    expect(calledWithGuildId).toBe("guildA");
  });
});

describe("mcpSearch", () => {
  test("rejects a guild_id outside the caller's permitted guilds", () => {
    const result = mcpSearch(session, { guild_id: "guildB" }, (() => []) as never);
    expect(result.isError).toBe(true);
  });

  test("drops rows with a non-null deleted_at", () => {
    const rows = [
      { discord_id: "1", deleted_at: null },
      { discord_id: "2", deleted_at: 12345 },
    ];
    const result = mcpSearch(session, { guild_id: "guildA" }, (() => rows) as never);
    const text = textOf(result);
    expect(text).toContain('"1"');
    expect(text).not.toContain('"2"');
  });

  test("always forces is_automod: false regardless of underlying rows", () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const searchFn = (args: Record<string, unknown>) => {
      receivedArgs = args;
      return [];
    };
    mcpSearch(session, { guild_id: "guildA" }, searchFn as never);
    expect(receivedArgs?.is_automod).toBe(false);
  });

  test("strips reply_to_content/reply_to_author_id — the LEFT JOIN parent row isn't checked for deleted_at/is_automod", () => {
    const rows = [
      {
        discord_id: "1",
        deleted_at: null,
        reply_to_content: "this parent message was deleted or automod-flagged",
        reply_to_author_id: "u2",
      },
    ];
    const result = mcpSearch(session, { guild_id: "guildA" }, (() => rows) as never);
    const text = textOf(result);
    expect(text).not.toContain("reply_to_content");
    expect(text).not.toContain("reply_to_author_id");
    expect(text).not.toContain("this parent message was deleted");
  });

  test("over-fetches so filtering deleted rows doesn't silently truncate below the requested limit", () => {
    let receivedLimit: number | undefined;
    const rows = [
      { discord_id: "1", deleted_at: null },
      { discord_id: "2", deleted_at: 111 },
      { discord_id: "3", deleted_at: null },
    ];
    const searchFn = (args: { limit?: number }) => {
      receivedLimit = args.limit;
      return rows;
    };
    const result = mcpSearch(session, { guild_id: "guildA", limit: 2 }, searchFn as never);
    expect(receivedLimit).toBeGreaterThan(2);
    const parsed = JSON.parse(textOf(result)) as { discord_id: string }[];
    expect(parsed.map((r) => r.discord_id)).toEqual(["1", "3"]);
  });

  test("caps the requested limit at 100 and floors it at 1", () => {
    let receivedLimit: number | undefined;
    const searchFn = (args: { limit?: number }) => {
      receivedLimit = args.limit;
      return [];
    };
    mcpSearch(session, { guild_id: "guildA", limit: -5 }, searchFn as never);
    expect(receivedLimit).toBeLessThanOrEqual(100);
    expect(receivedLimit).toBeGreaterThan(0);
  });
});

describe("mcpSend", () => {
  test("rejects a channel outside the caller's permitted guilds", async () => {
    const client = fakeClient("guildB");
    const webhookCache = { send: async () => {} } as unknown as WebhookCache;
    const result = await mcpSend(client, webhookCache, session, { channel_id: "c1", content: "hi" });
    expect(result.isError).toBe(true);
  });

  test("posts using the session's identity, ignoring any extra caller-supplied fields", async () => {
    const client = fakeClient("guildA");
    let sentIdentity: unknown;
    const webhookCache = {
      send: async (_c: unknown, _ch: unknown, _content: string, identity: unknown) => {
        sentIdentity = identity;
      },
    } as unknown as WebhookCache;

    const args = { channel_id: "c1", content: "hi", username: "evil", avatar_url: "http://evil" };
    const result = await mcpSend(client, webhookCache, session, args as never);

    expect(result.isError).toBeUndefined();
    expect(sentIdentity).toEqual(session.identity);
  });
});
