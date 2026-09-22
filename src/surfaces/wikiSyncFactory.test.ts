import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { SlackWikiSyncClient } from "./slack/wikiSync.ts";
import { makeCombinedWikiSourceContext } from "./wikiSyncFactory.ts";

const discordClient = {
  channels: { cache: { get: () => undefined }, fetch: async () => null },
} as unknown as Client<true>;

const slackClient = {
  users: { info: async () => ({}) },
  conversations: { info: async () => ({}) },
  chat: { postMessage: async () => ({}), update: async () => ({}) },
} as unknown as SlackWikiSyncClient;

describe("makeCombinedWikiSourceContext", () => {
  test("routes a discord source to the Discord context", () => {
    const make = makeCombinedWikiSourceContext({ discordClient, getSlack: () => undefined });
    expect(make("w1", { surface: "discord", spaceId: "g1" })).not.toBeNull();
  });

  test("routes a slack source to the Slack context when Slack is wired", () => {
    const make = makeCombinedWikiSourceContext({
      discordClient,
      getSlack: () => ({ client: slackClient, workspaceUrl: "https://acme.slack.com/" }),
    });
    expect(make("w1", { surface: "slack", spaceId: "T1" })).not.toBeNull();
  });

  test("skips a slack source (null) when Slack is not wired", () => {
    const make = makeCombinedWikiSourceContext({ discordClient, getSlack: () => undefined });
    expect(make("w1", { surface: "slack", spaceId: "T1" })).toBeNull();
  });

  test("skips an unknown surface (null)", () => {
    const make = makeCombinedWikiSourceContext({
      discordClient,
      getSlack: () => ({ client: slackClient, workspaceUrl: "https://acme.slack.com/" }),
    });
    expect(make("w1", { surface: "matrix", spaceId: "x" })).toBeNull();
  });
});
