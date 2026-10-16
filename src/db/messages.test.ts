import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageType, type Message } from "discord.js";
import { config } from "../config.ts";
import { closeDb, getDb, initDb } from "./index.ts";
import { insertMessage } from "./messages.ts";

const BOT_ID = "900";
const saved = { databasePath: config.databasePath, discordMessageContent: config.discordMessageContent };
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "messages-test-"));
  config.databasePath = join(tmp, "test.db");
  await initDb();
});

afterAll(async () => {
  closeDb();
  config.databasePath = saved.databasePath;
  config.discordMessageContent = saved.discordMessageContent;
  await rm(tmp, { recursive: true, force: true });
});

afterEach(() => {
  config.discordMessageContent = saved.discordMessageContent;
});

function fakeMessage(id: string, opts: { authorId?: string; mentionsBot?: boolean; content?: string } = {}): Message {
  const authorId = opts.authorId ?? "u1";
  return {
    id,
    guildId: "g1",
    channelId: "c1",
    channel: { isThread: () => false },
    client: { user: { id: BOT_ID } },
    author: { id: authorId, username: "someone", displayName: "someone", bot: authorId === BOT_ID },
    member: null,
    mentions: { users: new Map(opts.mentionsBot ? [[BOT_ID, {}]] : []) },
    content: opts.content ?? "",
    stickers: new Map(),
    attachments: new Map(),
    embeds: [],
    components: [],
    messageSnapshots: new Map(),
    reference: null,
    type: MessageType.Default,
    createdTimestamp: Date.now(),
  } as unknown as Message;
}

function stored(id: string): { content: string } | null {
  return getDb().query("SELECT content FROM messages WHERE discord_id = ?").get(id) as { content: string } | null;
}

describe("insertMessage without the MessageContent intent", () => {
  test("skips a guild message that neither mentions nor comes from the bot", () => {
    config.discordMessageContent = false;
    insertMessage(fakeMessage("1"));
    expect(stored("1")).toBeNull();
  });

  test("stores a message that mentions the bot", () => {
    config.discordMessageContent = false;
    insertMessage(fakeMessage("2", { mentionsBot: true, content: "hey bot" }));
    expect(stored("2")?.content).toBe("hey bot");
  });

  test("stores the bot's own message", () => {
    config.discordMessageContent = false;
    insertMessage(fakeMessage("3", { authorId: BOT_ID, content: "reply" }));
    expect(stored("3")?.content).toBe("reply");
  });

  test("stores every message when the flag is on", () => {
    config.discordMessageContent = true;
    insertMessage(fakeMessage("4", { content: "plain chatter" }));
    expect(stored("4")?.content).toBe("plain chatter");
  });
});
