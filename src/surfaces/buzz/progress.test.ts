import { describe, expect, test } from "bun:test";
import type { BuzzClient, BuzzSendResult } from "./buzzClient.ts";
import { BuzzToolProgress } from "./progress.ts";

const waitFlush = () => new Promise((r) => setTimeout(r, 1100)); // > DEBOUNCE_MS

interface Recorder {
  sends: { content: string; replyToId?: string }[];
  edits: { targetEventId: string; content: string }[];
}

function recordingClient(rec: Recorder, sendId = "prog-evt"): BuzzClient {
  return {
    async send(_c, content, replyToId): Promise<BuzzSendResult> { rec.sends.push({ content, replyToId }); return { eventId: sendId, accepted: true }; },
    async edit(_c, targetEventId, content) { rec.edits.push({ targetEventId, content }); },
    async ownPubkey() { return "me"; },
    async setProfile() {},
    async setPresence() {},
    subscribeMentions() { return { stop() {} }; },
    async react() {},
    async channelsList() { return []; },
    async channelType() { return "stream"; },
  };
}

describe("BuzzToolProgress", () => {
  test("first tool batch posts a working message, later batches edit it in place", async () => {
    const rec: Recorder = { sends: [], edits: [] };
    const p = new BuzzToolProgress(recordingClient(rec), "chan", "root");
    p.add([{ name: "wiki_search", input: { query: "deploy" } }]);
    await waitFlush();
    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0]).toMatchObject({ replyToId: "root" });
    expect(rec.sends[0].content).toContain("wiki_search(query=\"deploy\")");

    p.add([{ name: "read_channel", input: {} }]);
    await waitFlush();
    expect(rec.sends).toHaveLength(1); // no second post
    expect(rec.edits).toHaveLength(1);
    expect(rec.edits[0]).toMatchObject({ targetEventId: "prog-evt" });
    expect(rec.edits[0].content).toContain("read_channel");
  });

  test("only the last 3 tool lines show, with an earlier-calls header", async () => {
    const rec: Recorder = { sends: [], edits: [] };
    const p = new BuzzToolProgress(recordingClient(rec), "chan", "root");
    p.add([1, 2, 3, 4, 5].map((n) => ({ name: `t${n}`, input: {} })));
    await waitFlush();
    const c = rec.sends[0].content;
    expect(c).toContain("…2 earlier tool calls");
    expect(c).toContain("t5");
    expect(c).not.toContain("• t1");
  });

  test("finalize on a clean turn with no posted message creates nothing", async () => {
    const rec: Recorder = { sends: [], edits: [] };
    const p = new BuzzToolProgress(recordingClient(rec), "chan", "root");
    await p.finalize(); // no tools dispatched, no error
    expect(rec.sends).toHaveLength(0);
    expect(rec.edits).toHaveLength(0);
  });

  test("finalize with an error and no prior message posts the error as a fresh reply", async () => {
    const rec: Recorder = { sends: [], edits: [] };
    const p = new BuzzToolProgress(recordingClient(rec), "chan", "root");
    await p.finalize("it broke");
    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0]).toMatchObject({ replyToId: "root" });
    expect(rec.sends[0].content).toContain("⚠️ it broke");
    expect(rec.edits).toHaveLength(0);
  });

  test("finalize with an error and an existing message edits the error onto it", async () => {
    const rec: Recorder = { sends: [], edits: [] };
    const p = new BuzzToolProgress(recordingClient(rec), "chan", "root");
    p.add([{ name: "wiki_search", input: {} }]);
    await waitFlush();
    await p.finalize("it broke");
    expect(rec.edits.at(-1)?.content).toContain("⚠️ it broke");
    expect(rec.edits.at(-1)?.content).toContain("wiki_search");
    expect(rec.sends).toHaveLength(1); // only the original working post
  });
});
