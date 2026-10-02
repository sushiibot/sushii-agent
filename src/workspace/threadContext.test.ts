import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  threadAwareness,
  threadContextTools,
  threadIndex,
} from "./threadContext.ts";
import type { RunsRpcOptions } from "./runsRpc.ts";
import { ulid } from "./ulid.ts";

const T0 = Date.parse("2026-09-29T10:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
let root: string;
let opts: RunsRpcOptions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thread-context-"));
  opts = {
    principalId: "owner",
    stateDir: join(root, "state"),
    home: join(root, "home"),
    tz: "UTC",
    agentDirs: [join(root, "pi")],
    now: () => new Date(T0 + 3600000),
  };
  for (const dir of [
    opts.stateDir,
    opts.home,
    join(root, "pi", "topics", "trip"),
    join(root, "pi", "chat"),
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(opts.stateDir, "topics.json"),
    JSON.stringify({
      trip: { title: "Trip", archived: true },
      mail: { title: "Mail", archived: false },
      "../bad": { title: "Invalid" },
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function record(second: number, extra: object = {}) {
  const runId = ulid(T0 + second * 1000);
  appendFileSync(
    join(opts.stateDir, "runs.jsonl"),
    JSON.stringify({
      runId,
      agentName: "topic:trip",
      task: "Trip question",
      sessionFile: join(root, "pi", "topics", "trip", "s.jsonl"),
      startedAt: iso(second),
      endedAt: iso(second + 2),
      status: "done",
      ...extra,
    }) + "\n",
  );
  return runId;
}
async function tool(name: string, args: object = {}) {
  const definition = threadContextTools(opts).find((t) => t.name === name)!;
  const result = await definition.execute(
    "call",
    args as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );
  return JSON.parse((result.content[0] as { text: string }).text);
}

test("metadata index includes archived threads and legacy last activity without loading transcript contents", async () => {
  const parent = record(1, {
    resultSummary: "PRIVATE CONTENT MUST NOT ENTER PROMPT",
  });
  record(9, {
    agentName: "coder",
    parentRunId: parent,
    endedAt: iso(12),
  });
  record(3, { agentName: "main", conversationId: "mail" });
  expect(threadIndex(opts.stateDir)).toEqual([
    {
      id: "trip",
      title: "Trip",
      archived: true,
      href: "/chats/trip",
      lastActivity: iso(12),
    },
    {
      id: "mail",
      title: "Mail",
      archived: false,
      href: "/chats/mail",
      lastActivity: iso(5),
    },
  ]);
  expect(await tool("list_threads")).toEqual(threadIndex(opts.stateDir));
  const handlers = new Map<string, Function>();
  threadAwareness(opts.stateDir)({
    on: (event: string, handler: Function) => handlers.set(event, handler),
  } as never);
  handlers.get("before_agent_start")!();
  const messages = [
    { role: "system", content: "Base prompt", sections: { existing: "Keep" } },
    { role: "user", content: "Actual request" },
  ];
  const result = handlers.get("context_with_system")!({ messages });
  expect(result.messages[1]).toBe(messages[1]);
  expect(result.messages[0].content).toBe("Base prompt");
  expect(result.messages[0].sections.existing).toBe("Keep");
  const prompt = result.messages[0].sections.threadIndex;
  expect(prompt).toContain('"archived":true');
  expect(prompt).toContain("do not retrieve every thread by default");
  expect(prompt).not.toContain("PRIVATE CONTENT");
  // Metadata changes between tool calls must not change a turn's cached prefix.
  writeFileSync(join(opts.stateDir, "topics.json"), "{}");
  expect(handlers.get("context_with_system")!({ messages })).toEqual(result);
  handlers.get("before_agent_start")!();
  expect(handlers.get("context_with_system")!({ messages })).toBeUndefined();
});

test("history retrieves existing topic runs without conversationId, confines run windows and excludes other threads", async () => {
  const path = join(root, "pi", "topics", "trip", "s.jsonl");
  writeFileSync(
    path,
    [
      {
        type: "session",
        version: 3,
        id: "s",
        timestamp: iso(-10),
        cwd: opts.home,
      },
      {
        type: "message",
        id: "old",
        timestamp: iso(0),
        message: { role: "user", content: "Outside selected run" },
      },
      {
        type: "message",
        id: "u",
        timestamp: iso(2),
        message: { role: "user", content: "Where shall we stay?" },
      },
      {
        type: "message",
        id: "a",
        timestamp: iso(3),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Try Kyoto." },
            {
              type: "toolCall",
              id: "t",
              name: "read",
              arguments: { path: "file" },
            },
          ],
        },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n") + "\n",
  );
  const runId = record(1);
  record(4, {
    agentName: "topic:mail",
    task: "PRIVATE MAIL",
    conversationId: "mail",
  });
  record(5, { agentName: "coder", parentRunId: runId, task: "DELEGATED WORK" });
  const result = await tool("get_thread_history", { id: "trip" });
  expect(result.threadId).toBe("trip");
  expect(result.history).toHaveLength(1);
  expect(result.history[0].session).toBe("ok");
  expect(result.history[0].steps.map((s: { text: string }) => s.text)).toEqual([
    "Where shall we stay?",
    "Try Kyoto.",
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE MAIL");
  expect(JSON.stringify(result)).not.toContain("Outside selected run");
  expect(threadIndex(opts.stateDir)[0]?.archived).toBe(true);
});

test("summary retrieval pages topic runs and rejects unknown thread IDs", async () => {
  const ids = Array.from({ length: 9 }, (_, i) =>
    record(i * 4, { resultSummary: `Summary ${i}` }),
  );
  const first = await tool("get_thread_history", {
    id: "trip",
    summariesOnly: true,
  });
  expect(first.history).toHaveLength(8);
  expect(first.history[0].summary).toBe("Summary 1");
  expect(first.history[7].summary).toBe("Summary 8");
  expect(first.before).toBe(ids[1]);
  const second = await tool("get_thread_history", {
    id: "trip",
    summariesOnly: true,
    before: first.before,
  });
  expect(second.history).toEqual([
    { runId: ids[0], at: iso(0), summary: "Summary 0" },
  ]);
  expect(second.before).toBeNull();
  await expect(tool("get_thread_history", { id: "../trip" })).rejects.toThrow(
    "Unknown thread",
  );
});
