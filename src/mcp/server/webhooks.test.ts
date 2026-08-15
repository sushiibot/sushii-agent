import { describe, expect, test } from "bun:test";
import { DiscordAPIError, RESTJSONErrorCodes, WebhookType } from "discord.js";
import type { Client, GuildTextBasedChannel } from "discord.js";
import { WebhookCache } from "./webhooks.ts";

const identity = { id: "u1", username: "alice", avatar: null };

function fakeUnknownWebhookError(): DiscordAPIError {
  return new DiscordAPIError(
    { message: "Unknown Webhook", code: RESTJSONErrorCodes.UnknownWebhook },
    RESTJSONErrorCodes.UnknownWebhook,
    404,
    "POST",
    "https://discord.com/api/webhooks/1/token",
    { body: null },
  );
}

interface FakeWebhook {
  id: string;
  type: WebhookType;
  owner: { id: string } | null;
  send: () => Promise<void>;
}

function fakeChannel(opts: {
  existingWebhooks?: FakeWebhook[];
  createdId?: string;
  onFetchWebhooks?: () => void;
  onCreateWebhook?: () => void;
  fetchWebhooksGate?: Promise<void>;
  sendImpls?: Record<string, () => Promise<void>>;
}) {
  let created = 0;
  const send = (id: string) => async () => {
    const impl = opts.sendImpls?.[id];
    if (impl) return impl();
  };
  return {
    id: "chan1",
    isThread: () => false,
    fetchWebhooks: async () => {
      opts.onFetchWebhooks?.();
      await opts.fetchWebhooksGate;
      const list = opts.existingWebhooks ?? [];
      return { find: (fn: (w: FakeWebhook) => boolean) => list.find(fn) };
    },
    createWebhook: async () => {
      created++;
      opts.onCreateWebhook?.();
      const id = opts.createdId ?? `created-${created}`;
      return { id, type: WebhookType.Incoming, owner: { id: "bot1" }, send: send(id) };
    },
  } as unknown as GuildTextBasedChannel;
}

function fakeClient(): Client<true> {
  return { user: { id: "bot1" } } as unknown as Client<true>;
}

describe("WebhookCache", () => {
  test("creates a webhook on first use", async () => {
    let createCalls = 0;
    const channel = fakeChannel({
      existingWebhooks: [],
      onCreateWebhook: () => createCalls++,
      sendImpls: { "created-1": async () => {} },
    });
    const cache = new WebhookCache();

    await cache.send(fakeClient(), channel, "hi", identity);
    expect(createCalls).toBe(1);
  });

  test("reuses an existing bot-owned webhook instead of creating a new one", async () => {
    let createCalls = 0;
    const channel = fakeChannel({
      existingWebhooks: [
        { id: "existing1", type: WebhookType.Incoming, owner: { id: "bot1" }, send: async () => {} },
      ],
      onCreateWebhook: () => createCalls++,
    });
    const cache = new WebhookCache();

    await cache.send(fakeClient(), channel, "hi", identity);
    expect(createCalls).toBe(0);
  });

  test("skips webhooks not owned by the bot or not of Incoming type", async () => {
    let createCalls = 0;
    const channel = fakeChannel({
      existingWebhooks: [
        { id: "other-owner", type: WebhookType.Incoming, owner: { id: "someone-else" }, send: async () => {} },
        { id: "follower", type: WebhookType.ChannelFollower, owner: { id: "bot1" }, send: async () => {} },
      ],
      createdId: "fresh",
      onCreateWebhook: () => createCalls++,
      sendImpls: { fresh: async () => {} },
    });
    const cache = new WebhookCache();

    await cache.send(fakeClient(), channel, "hi", identity);
    expect(createCalls).toBe(1);
  });

  test("subsequent sends to the same channel reuse the in-memory cache, not a fresh fetch", async () => {
    let fetchCalls = 0;
    const channel = fakeChannel({
      existingWebhooks: [
        { id: "existing1", type: WebhookType.Incoming, owner: { id: "bot1" }, send: async () => {} },
      ],
      onFetchWebhooks: () => fetchCalls++,
    });
    const client = fakeClient();
    const cache = new WebhookCache();

    await cache.send(client, channel, "one", identity);
    await cache.send(client, channel, "two", identity);
    expect(fetchCalls).toBe(1);
  });

  test("self-heals within the same call after a 404 on execute: evicts, recreates, retries once, delivers", async () => {
    let sendAttempts = 0;
    let createCalls = 0;
    // Simulates the webhook having been deleted externally (e.g. by a server admin):
    // it's cached from an earlier send, but a fresh GET /webhooks no longer lists it.
    const webhooks: FakeWebhook[] = [
      {
        id: "stale",
        type: WebhookType.Incoming,
        owner: { id: "bot1" },
        send: async () => {
          sendAttempts++;
          webhooks.length = 0; // the delete-out-from-under-us happens between the two attempts
          throw fakeUnknownWebhookError();
        },
      },
    ];
    const channel = fakeChannel({
      existingWebhooks: webhooks,
      createdId: "fresh",
      onCreateWebhook: () => createCalls++,
      sendImpls: {
        fresh: async () => {
          sendAttempts++;
        },
      },
    });
    const cache = new WebhookCache();

    await cache.send(fakeClient(), channel, "hi", identity);

    expect(sendAttempts).toBe(2);
    expect(createCalls).toBe(1);
  });

  test("concurrent first sends to an uncached channel dedupe into a single webhook creation", async () => {
    let createCalls = 0;
    let fetchCalls = 0;
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const channel = fakeChannel({
      existingWebhooks: [],
      onCreateWebhook: () => createCalls++,
      onFetchWebhooks: () => fetchCalls++,
      fetchWebhooksGate: gate,
      sendImpls: { "created-1": async () => {} },
    });
    const client = fakeClient();
    const cache = new WebhookCache();

    const first = cache.send(client, channel, "one", identity);
    const second = cache.send(client, channel, "two", identity);
    releaseFetch();
    await Promise.all([first, second]);

    expect(fetchCalls).toBe(1);
    expect(createCalls).toBe(1);
  });
});
