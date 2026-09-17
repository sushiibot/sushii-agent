import { describe, expect, test } from "bun:test";
import { buildTriggerText } from "./inbound.ts";

// Golden for the user-turn framing. Expected strings were derived from the pre-cutover bot.ts
// MessageCreate query build (bot-mention strip → emoji map → discord.com→msg: rewrite → bare-ping
// fallback → "[Message from USERNAME (<@ID>)]" wrapper, with replyContext prepended). This must not
// drift: the core relays InboundMessage.text verbatim into the model turn.
const BARE =
  "[No message text — review the recent activity shown in your context, investigate anything unclear or needing moderator attention, and summarize what's going on. If nothing needs attention, say so briefly.]";

describe("buildTriggerText golden parity", () => {
  test("plain mention", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@BOT> hello world", emojiMap: {}, authorUsername: "alice", authorId: "U1", replyContext: "" }))
      .toBe("[Message from alice (<@U1>)]\nhello world");
  });

  test("nickname-form mention (<@!id>) is stripped", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@!BOT>   hey", emojiMap: {}, authorUsername: "alice", authorId: "U1", replyContext: "" }))
      .toBe("[Message from alice (<@U1>)]\nhey");
  });

  test("bare ping, no attachments", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@BOT>", emojiMap: {}, authorUsername: "bob", authorId: "U2", replyContext: "", barePingFlattened: "<@BOT>" }))
      .toBe(`[Message from bob (<@U2>)]\n${BARE}`);
  });

  test("bare ping with an attachment carried in the flattened content", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@BOT>", emojiMap: {}, authorUsername: "bob", authorId: "U2", replyContext: "", barePingFlattened: "[image: cat.png](https://cdn/x)" }))
      .toBe(`[Message from bob (<@U2>)]\n[image: cat.png](https://cdn/x)\n${BARE}`);
  });

  test("reply to a non-bot message prepends the reply context before the wrapper", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@BOT> what about this", emojiMap: {}, authorUsername: "alice", authorId: "U1", replyContext: "Replying to u:U9 (charlie):\nsome text\n\n" }))
      .toBe("Replying to u:U9 (charlie):\nsome text\n\n[Message from alice (<@U1>)]\nwhat about this");
  });

  test("custom emoji is normalized to the configured syntax; unknown emoji is left as-is", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@BOT> nice <:Kek:123> and <:Unknown:5>", emojiMap: { Kek: "<:Kek:999>" }, authorUsername: "alice", authorId: "U1", replyContext: "" }))
      .toBe("[Message from alice (<@U1>)]\nnice <:Kek:999> and <:Unknown:5>");
  });

  test("discord.com message link is rewritten to msg:channel/message", () => {
    expect(buildTriggerText({ botId: "BOT", rawContent: "<@BOT> see https://discord.com/channels/111/222/333", emojiMap: {}, authorUsername: "alice", authorId: "U1", replyContext: "" }))
      .toBe("[Message from alice (<@U1>)]\nsee msg:222/333");
  });
});
