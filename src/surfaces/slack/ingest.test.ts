import { describe, expect, test } from "bun:test";
import {
  slackDeleteToRow,
  slackEventToRow,
  slackTsToMs,
  type SlackMessageEvent,
} from "./ingest.ts";

describe("slackEventToRow", () => {
  test("maps a plain message", () => {
    const e: SlackMessageEvent = { type: "message", channel: "C1", ts: "1609459200.000400", user: "U1", text: "hi", team: "T1" };
    const r = slackEventToRow(e, 5);
    expect(r).toMatchObject({ channel: "C1", ts: "1609459200.000400", user: "U1", text: "hi", team: "T1", ingestedAt: 5 });
    expect(r.createdAt).toBe(slackTsToMs("1609459200.000400"));
    expect(JSON.parse(r.rawJson)).toMatchObject({ ts: "1609459200.000400" });
  });

  test("threaded reply keeps thread_ts and serializes blocks/files", () => {
    const e: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1002.0000",
      thread_ts: "1000.0000",
      user: "U2",
      text: "reply",
      blocks: [{ type: "section" }],
      files: [{ id: "F1" }],
    };
    const r = slackEventToRow(e, 1);
    expect(r.threadTs).toBe("1000.0000");
    expect(JSON.parse(r.blocks!)).toEqual([{ type: "section" }]);
    expect(JSON.parse(r.files!)).toEqual([{ id: "F1" }]);
  });

  test("bot message captures bot_id and subtype", () => {
    const e: SlackMessageEvent = { type: "message", channel: "C1", ts: "1003.0000", subtype: "bot_message", bot_id: "B1", text: "beep" };
    const r = slackEventToRow(e, 1);
    expect(r.botId).toBe("B1");
    expect(r.subtype).toBe("bot_message");
    expect(r.user).toBeNull();
  });

  test("message_changed keys the row on the edited message ts, not the envelope", () => {
    const e: SlackMessageEvent = {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      ts: "1099.9999",
      message: { type: "message", ts: "1005.0000", user: "U1", text: "edited", edited: { ts: "1099.9999" } },
      previous_message: { type: "message", ts: "1005.0000", text: "original" },
    };
    const r = slackEventToRow(e, 1);
    expect(r.ts).toBe("1005.0000");
    expect(r.text).toBe("edited");
    expect(r.editedTs).toBe("1099.9999");
    // the true subtype is carried, not the "message_changed" envelope
    expect(r.subtype).toBeNull();
  });

  test("throws (loud, not silent) on a message missing channel/ts", () => {
    expect(() => slackEventToRow({ type: "message", text: "orphan" }, 1)).toThrow();
  });
});

describe("slackDeleteToRow", () => {
  test("recovers content from previous_message and marks deletedAt", () => {
    const e: SlackMessageEvent = {
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      deleted_ts: "1005.0000",
      previous_message: { type: "message", ts: "1005.0000", user: "U1", text: "gone" },
    };
    const r = slackDeleteToRow(e, 99);
    expect(r.channel).toBe("C1");
    expect(r.ts).toBe("1005.0000");
    expect(r.text).toBe("gone");
    expect(r.deletedAt).toBe(99);
  });
});
