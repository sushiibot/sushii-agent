import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
import { applySchema } from "../../db/index.ts";
import type { GuildConfig } from "../../guildConfig.ts";
import { classifyText, parseSafetyOutput, type ImageVerdict, type TextVerdict } from "./classify.ts";
import { discordImageLink, extractImageLinks } from "./images.ts";
import { ignorePost, judgedLines, recordMessagesDeleted, recordModAction, screenMessage, type ScreenedMessage, type ScreeningDeps } from "./index.ts";
import { buildVerdictPost, scoreBars, topRule } from "./render.ts";
import { SCREENING_RULES } from "./rules.ts";
import { getVerdict } from "./store.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const GUILD = "g1";
const CHANNEL = "c1";
const LOG = "log1";
const NEWBIE = "u-new";

const cfg: GuildConfig = { allowedRoles: ["mod-role"], alertsChannelId: LOG, enabledModules: ["screening"] };

function cacheMessage(db: Database, id: string, authorId: string, content: string, createdAt: number, name = authorId): void {
  db.run(
    `INSERT INTO messages (discord_id, guild_id, channel_id, author_id, content, created_at, author_username) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, GUILD, CHANNEL, authorId, content, createdAt, name],
  );
}

function msg(overrides: Partial<ScreenedMessage> = {}, member: Partial<NonNullable<ScreenedMessage["member"]>> = {}): ScreenedMessage {
  return {
    id: "m-target",
    guildId: GUILD,
    channelId: CHANNEL,
    createdTimestamp: NOW,
    content: "free nitro, claim at discord-gift.ru",
    embeds: [],
    author: { id: NEWBIE, bot: false, avatar: null },
    member: { joinedTimestamp: NOW - 2 * HOUR, avatar: null, roleIds: [], avatarUrl: "https://cdn.discordapp.com/avatars/u/a.png", ...member },
    ...overrides,
  };
}

interface Harness {
  db: Database;
  deps: ScreeningDeps;
  posts: { channelId: string; container: ContainerBuilder }[];
  edits: { messageId: string; container: ContainerBuilder }[];
  textCalls: number;
  imageCalls: string[];
}

function harness(text: Partial<TextVerdict["scores"]> = { scam: 0.9, troll: 0.1 }, image: Partial<ImageVerdict> = {}): Harness {
  const db = new Database(":memory:");
  applySchema(db);
  const h: Harness = { db, posts: [], edits: [], textCalls: 0, imageCalls: [], deps: undefined as unknown as ScreeningDeps };
  let postId = 0;
  h.deps = {
    db,
    now: () => NOW,
    classifyText: async () => {
      h.textCalls++;
      return { scores: text, model: "typesafe/jev-1.13-20260917", cost: 0.00002 };
    },
    classifyImage: async (url) => {
      h.imageCalls.push(url);
      return { unsafe: false, categories: [], model: "nvidia/nemotron-3.5-content-safety", cost: 0.0002, ...image };
    },
    post: async (channelId, container) => {
      h.posts.push({ channelId, container });
      return `post-${++postId}`;
    },
    edit: async (_channelId, messageId, container) => {
      h.edits.push({ messageId, container });
    },
  };
  return h;
}

function postJson(c: ContainerBuilder): string {
  return JSON.stringify(c.toJSON());
}

describe("scoreBars", () => {
  test("fixed-length bars with grey remainder and threshold colors", () => {
    const out = scoreBars({ scam: 0.91, spam: 0.47, troll: 0.1 }, 0.35);
    expect(out.startsWith("```ansi\n")).toBe(true);
    const lines = out.split("\n").slice(1, -1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("\u001b[1;31mscam");
    expect(lines[0]).toContain("0.91 " + "█".repeat(9));
    expect(lines[0]).toContain("░".repeat(1));
    expect(lines[1]).toContain("\u001b[1;33mspam");
    expect(lines[2]).toContain("\u001b[0;30mtroll");
    for (const l of lines) {
      const plain = l.replace(/\u001b\[[\d;]+m/g, "");
      expect((plain.match(/[█░]/g) ?? []).length).toBe(10);
    }
  });

  test("topRule picks the highest score", () => {
    expect(topRule({ scam: 0.2, troll: 0.8 })).toBe("troll");
    expect(topRule({})).toBeNull();
  });
});

describe("image links", () => {
  test("only Discord-hosted image URLs, keyed without host or signature", () => {
    const a = discordImageLink("https://cdn.discordapp.com/attachments/1/2/x.png?ex=1&is=2&hm=3");
    const b = discordImageLink("https://media.discordapp.net/attachments/1/2/x.png?ex=9");
    expect(a?.key).toBe("/attachments/1/2/x.png");
    expect(b?.key).toBe(a?.key);
    expect(discordImageLink("https://i.imgur.com/x.png")).toBeNull();
    expect(discordImageLink("http://cdn.discordapp.com/attachments/1/2/x.png")).toBeNull();
    expect(discordImageLink("https://cdn.discordapp.com/attachments/1/2/file.zip")).toBeNull();
  });

  test("extracts from content and embeds, dedupes, caps at 3", () => {
    const content = [1, 2, 3, 4].map((i) => `https://cdn.discordapp.com/attachments/1/${i}/a.gif`).join(" ") + " https://cdn.discordapp.com/attachments/1/1/a.gif?ex=2";
    expect(extractImageLinks(content)).toHaveLength(3);
    const fromEmbed = extractImageLinks("https://i.imgur.com/x.jpg", [{ image: { proxyURL: "https://media.discordapp.net/external/abc/https/i.imgur.com/x.jpg" } }]);
    expect(fromEmbed.map((l) => l.key)).toEqual(["/external/abc/https/i.imgur.com/x.jpg"]);
  });
});

describe("classify", () => {
  test("parseSafetyOutput", () => {
    expect(parseSafetyOutput("User Safety: safe")).toEqual({ unsafe: false, categories: [] });
    expect(parseSafetyOutput("User Safety: unsafe\nSafety Categories: Sexual, Violence")).toEqual({ unsafe: true, categories: ["Sexual", "Violence"] });
    expect(() => parseSafetyOutput("I cannot help")).toThrow();
  });

  test("classifyText sends one noul per rule and reads answers", async () => {
    let body: { questions: Record<string, { type: string }> } | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      const answers = Object.fromEntries(SCREENING_RULES.map((r) => [r.id, { type: "noul", noul: r.id === "scam" ? 0.95 : 0.01 }]));
      return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { cost: 0.00001 } }));
    }) as unknown as typeof fetch;
    const v = await classifyText([{ id: "m1", author: "a", target: true, text: "x" }], SCREENING_RULES, fakeFetch);
    expect(Object.keys(body!.questions)).toEqual(SCREENING_RULES.map((r) => r.id));
    expect(body!.questions["scam"]!.type).toBe("noul");
    expect(v.scores.scam).toBe(0.95);
    expect(v.cost).toBe(0.00001);
  });
});

describe("judgedLines", () => {
  test("target lines plus the two others right before the first target line", () => {
    const rows = ["a", "b", "c", NEWBIE, "d", NEWBIE].map((author, i) => ({
      discord_id: `m${i}`, author_id: author, author_username: author, author_display_name: null, content: `t${i}`,
    }));
    const j = judgedLines(rows, NEWBIE);
    expect(j.context.map((l) => l.text)).toEqual(["t1", "t2"]);
    expect(j.target.map((l) => l.text)).toEqual(["t3", "t5"]);
  });
});

describe("screenMessage", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    cacheMessage(h.db, "m-ctx", "kevin", "anyone know when the event starts", NOW - 60_000);
    cacheMessage(h.db, "m-target", NEWBIE, "free nitro, claim at discord-gift.ru", NOW, "nitrodrops_");
  });

  test("flags a new member's message and posts to the alerts channel", async () => {
    await screenMessage(msg(), cfg, h.deps);
    expect(h.textCalls).toBe(1);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.channelId).toBe(LOG);
    const json = postJson(h.posts[0]!.container);
    expect(json).toContain("Suspicious message · likely scam");
    expect(json).toContain("message #1 since join");
    expect(json).toContain("-# kevin: anyone know");
    expect(json).toContain("> **nitrodrops_:** free nitro");
    expect(json).toContain("scr:ignore:");
    const row = getVerdict(h.db, 1)!;
    expect(row.flagged).toBe(1);
    expect(row.postMessageId).toBe("post-1");
  });

  test("skips members outside the window, mods, and disabled guilds", async () => {
    await screenMessage(msg({}, { joinedTimestamp: NOW - 8 * 24 * HOUR }), cfg, h.deps);
    await screenMessage(msg({}, { roleIds: ["mod-role"] }), cfg, h.deps);
    await screenMessage(msg(), { ...cfg, enabledModules: ["moderation"] }, h.deps);
    expect(h.textCalls).toBe(0);
  });

  test("below threshold is logged but not posted; no channel means log only", async () => {
    const low = harness({ scam: 0.1 });
    cacheMessage(low.db, "m-target", NEWBIE, "hi", NOW);
    await screenMessage(msg({ content: "hi" }), cfg, low.deps);
    expect(low.posts).toHaveLength(0);
    expect(getVerdict(low.db, 1)?.flagged).toBe(0);

    await screenMessage(msg(), { ...cfg, alertsChannelId: undefined }, h.deps);
    expect(h.posts).toHaveLength(0);
    expect(getVerdict(h.db, 1)?.flagged).toBe(1);
  });

  test("a burst from the same user edits the open post", async () => {
    await screenMessage(msg(), cfg, h.deps);
    cacheMessage(h.db, "m-target-2", NEWBIE, "dm me for more", NOW + 1000, "nitrodrops_");
    await screenMessage(msg({ id: "m-target-2", createdTimestamp: NOW + 1000, content: "dm me for more" }), cfg, h.deps);
    expect(h.posts).toHaveLength(1);
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.messageId).toBe("post-1");
    expect(getVerdict(h.db, 2)?.postMessageId).toBe("post-1");
  });

  test("concurrent messages in a fast burst still share one post", async () => {
    const slow = h.deps.classifyText!;
    h.deps.classifyText = async (m, r) => {
      await Bun.sleep(5);
      return slow(m, r);
    };
    cacheMessage(h.db, "m-target-2", NEWBIE, "dm me for more", NOW + 1000, "nitrodrops_");
    await Promise.all([
      screenMessage(msg(), cfg, h.deps),
      screenMessage(msg({ id: "m-target-2", createdTimestamp: NOW + 1000, content: "dm me for more" }), cfg, h.deps),
    ]);
    expect(h.posts).toHaveLength(1);
    expect(h.edits).toHaveLength(1);
  });

  test("profile picture is checked once per avatar hash", async () => {
    const m = msg({ content: "" }, { avatar: "hash1" });
    await screenMessage(m, cfg, h.deps);
    await screenMessage(m, cfg, h.deps);
    expect(h.imageCalls).toHaveLength(1);
    await screenMessage(msg({ content: "" }, { avatar: "hash2" }), cfg, h.deps);
    expect(h.imageCalls).toHaveLength(2);
  });

  test("unsafe image link is posted with a spoilered gallery", async () => {
    const hi = harness({ scam: 0 }, { unsafe: true, categories: ["Sexual"] });
    const content = "look https://cdn.discordapp.com/attachments/1/2/pic.jpg?ex=1";
    cacheMessage(hi.db, "m-target", NEWBIE, content, NOW);
    await screenMessage(msg({ content }), cfg, hi.deps);
    expect(hi.imageCalls).toEqual(["https://cdn.discordapp.com/attachments/1/2/pic.jpg?ex=1"]);
    expect(hi.posts).toHaveLength(1);
    const json = postJson(hi.posts[0]!.container);
    expect(json).toContain("Suspicious image link · sexual");
    expect(json).toContain('"spoiler":true');
    // same image re-shared with a fresh signature is not re-checked
    await screenMessage(msg({ id: "m2", content: "https://media.discordapp.net/attachments/1/2/pic.jpg?ex=2" }), cfg, hi.deps);
    expect(hi.imageCalls).toHaveLength(1);
  });

  test("classifier failure is recorded and does not throw", async () => {
    h.deps.classifyText = async () => {
      throw new Error("boom");
    };
    await screenMessage(msg(), cfg, h.deps);
    expect(getVerdict(h.db, 1)?.error).toContain("boom");
    expect(h.posts).toHaveLength(0);
  });
});

describe("outcomes", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    cacheMessage(h.db, "m-target", NEWBIE, "free nitro", NOW);
    await screenMessage(msg(), cfg, h.deps);
  });

  test("ignore marks the post and drops the Ignore button", () => {
    const c = ignorePost("post-1", "mod1", cfg, h.deps);
    expect(c).not.toBeNull();
    const json = postJson(c!);
    expect(json).toContain("ignored by <@mod1>");
    expect(json).not.toContain("scr:ignore:");
    expect(getVerdict(h.db, 1)?.outcome).toBe("ignored");
    expect(ignorePost("post-1", "mod2", cfg, h.deps)).toBeNull();
  });

  test("a ban overrides ignore and edits the post", async () => {
    ignorePost("post-1", "mod1", cfg, h.deps);
    await recordModAction(GUILD, NEWBIE, "banned", "mod2", cfg, h.deps);
    const row = getVerdict(h.db, 1)!;
    expect(row.outcome).toBe("actioned");
    expect(row.outcomeAction).toBe("banned");
    expect(h.edits).toHaveLength(1);
    expect(postJson(h.edits[0]!.container)).toContain("🔨 banned by <@mod2>");
  });

  test("deleting the flagged message updates the post and disables jump", async () => {
    await recordMessagesDeleted(["m-target"], cfg, h.deps);
    expect(getVerdict(h.db, 1)?.messageDeleted).toBe(1);
    expect(postJson(h.edits[0]!.container)).toContain("**message deleted**");
  });

  test("rendering a pfp verdict uses a spoilered thumbnail", () => {
    const row = { ...getVerdict(h.db, 1)!, kind: "pfp" as const, sourceUrl: "https://cdn.discordapp.com/avatars/u/a.png", categories: '["Sexual"]' };
    const json = postJson(buildVerdictPost(row, 0.35));
    expect(json).toContain("Suspicious profile picture · sexual");
    expect(json).toContain('"spoiler":true');
  });
});
