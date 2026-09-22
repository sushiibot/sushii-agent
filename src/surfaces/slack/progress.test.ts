import { describe, expect, test } from "bun:test";
import type { SlackPostClient } from "./session.ts";
import { SlackToolProgress } from "./progress.ts";

const waitFlush = () => new Promise((r) => setTimeout(r, 600)); // > DEBOUNCE_MS

interface Recorder {
  posts: { text: string; thread_ts?: string }[];
  updates: { ts: string; text: string }[];
}

function recordingClient(rec: Recorder, postTs = "prog.0001"): SlackPostClient {
  return {
    chat: {
      async postMessage(args) { rec.posts.push({ text: args.text, thread_ts: args.thread_ts }); return { ts: postTs }; },
      async update(args) { rec.updates.push({ ts: args.ts, text: args.text }); return {}; },
    },
    reactions: { async add() { return {}; } },
    users: { async info() { return { user: {} }; } },
  };
}

describe("SlackToolProgress", () => {
  test("first tool batch posts a working message, later batches edit it in place", async () => {
    const rec: Recorder = { posts: [], updates: [] };
    const p = new SlackToolProgress(recordingClient(rec), "C1", "root");
    p.add([{ name: "wiki_search", input: { query: "deploy" } }]);
    await waitFlush();
    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0]).toMatchObject({ thread_ts: "root" });
    expect(rec.posts[0].text).toContain("wiki_search(query=\"deploy\")");

    p.add([{ name: "read_channel", input: {} }]);
    await waitFlush();
    expect(rec.posts).toHaveLength(1); // no second post
    expect(rec.updates).toHaveLength(1);
    expect(rec.updates[0]).toMatchObject({ ts: "prog.0001" });
    expect(rec.updates[0].text).toContain("read_channel");
  });

  test("only the last 3 tool lines show, with an earlier-calls header", async () => {
    const rec: Recorder = { posts: [], updates: [] };
    const p = new SlackToolProgress(recordingClient(rec), "C1", "root");
    p.add([1, 2, 3, 4, 5].map((n) => ({ name: `t${n}`, input: {} })));
    await waitFlush();
    const c = rec.posts[0].text;
    expect(c).toContain("…2 earlier tool calls");
    expect(c).toContain("t5");
    expect(c).not.toContain("• t1");
  });

  test("finalize on a clean turn with no posted message creates nothing", async () => {
    const rec: Recorder = { posts: [], updates: [] };
    const p = new SlackToolProgress(recordingClient(rec), "C1", "root");
    await p.finalize();
    expect(rec.posts).toHaveLength(0);
    expect(rec.updates).toHaveLength(0);
  });

  test("finalize with an error and no prior message posts the error as a fresh reply", async () => {
    const rec: Recorder = { posts: [], updates: [] };
    const p = new SlackToolProgress(recordingClient(rec), "C1", "root");
    await p.finalize("it broke");
    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0]).toMatchObject({ thread_ts: "root" });
    expect(rec.posts[0].text).toContain("⚠️ it broke");
    expect(rec.updates).toHaveLength(0);
  });

  test("finalize with an error and an existing message edits the error onto it", async () => {
    const rec: Recorder = { posts: [], updates: [] };
    const p = new SlackToolProgress(recordingClient(rec), "C1", "root");
    p.add([{ name: "wiki_search", input: {} }]);
    await waitFlush();
    await p.finalize("it broke");
    expect(rec.updates.at(-1)?.text).toContain("⚠️ it broke");
    expect(rec.updates.at(-1)?.text).toContain("wiki_search");
    expect(rec.posts).toHaveLength(1);
  });
});
