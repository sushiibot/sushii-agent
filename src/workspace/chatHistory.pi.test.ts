import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WorkspaceConfig } from "./config.ts";
import { scaffoldHome } from "./home.ts";
import { PersonalSession, type ChatTransport } from "./personalSession.ts";
import { createPiChatSessionFactory } from "./piChatSession.ts";
import { ChatHistoryReader, DELIVERY_ENTRY, SESSION_ENTRY } from "./chatHistory.ts";
import { chatHistoryResult, type ChatDeliverParams } from "../orchestration/contracts.ts";

// Real Pi 0.99.1 sessions from the workspace factory; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";

let root: string;
let replies: Array<() => Response>;
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

type Reply = { text?: string; tool?: { name: string; args: object } };

function sse(reply: Reply, n: number): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "openai/gpt-6-luna", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }
    : { role: "assistant", content: reply.text ?? "" };
  const body = chunk(delta, null) + chunk({}, reply.tool ? "tool_calls" : "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let calls = 0;
function script(...rs: Array<Reply | (() => Reply)>): void {
  replies.push(...rs.map((r) => () => sse(typeof r === "function" ? r() : r, calls)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-history-pi-"));
  replies = [];
  calls = 0;
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    if (!url.startsWith(`${OPENROUTER_BASE}/chat/completions`)) throw new Error(`unexpected fetch in test: ${url}`);
    calls++;
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

function config(): WorkspaceConfig {
  return {
    provider: "openrouter",
    chatgptModel: "gpt-6.1-sol",
    model: "openai/gpt-6-luna",
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
  } as WorkspaceConfig;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function host() {
  const cfg = config();
  await scaffoldHome(cfg.home);
  const delivered: ChatDeliverParams[] = [];
  const transport: ChatTransport = {
    request: async (method, params) => {
      if (method === "chat/deliver") delivered.push(params as ChatDeliverParams);
      return {};
    },
    notify: () => {},
  };
  const personal = new PersonalSession({ principalId: "drk", model: cfg.model, stateDir: cfg.stateDir, factory: createPiChatSessionFactory(cfg), transport, textDeltaMs: null });
  await personal.start();
  return { personal, delivered, reader: new ChatHistoryReader({ agentDir: cfg.agentDir }) };
}

const web = (clientId: string, text: string) => ({
  principalId: "drk",
  origin: { surface: "web", conversationId: "main" },
  messageId: clientId,
  text,
  kind: "user" as const,
  author: { id: "drklee3@github", name: "drk" },
});

type Line = { type: string; id?: string; parentId?: string | null; customType?: string; data?: { kind?: string; reason?: string }; message?: { role?: string } };
const linesOf = (file: string): Line[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);

describe("delivery markers on a real Pi session", () => {
  test("a marker appended mid-run extends the branch: the next message chains after it, nothing forks", async () => {
    const { personal, delivered, reader } = await host();
    script({ tool: { name: "ls", args: { path: "." } } }, () => {
      // Runs while the turn streams: after the tool result, before the final assistant message.
      personal.deliverOutOfBand({ kind: "proactive", text: "mid-run ping" });
      return { text: "here are the files" };
    });
    await personal.handleMessage(web("01J00000000000000000000001", "list my home"));
    await until(() => delivered.length === 2);

    const entries = linesOf(personal.currentSessionFile).filter((e) => e.type !== "session");
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.parentId).toBe(entries[i - 1]!.id!);
    const markers = entries.filter((e) => e.type === "custom" && e.customType === DELIVERY_ENTRY);
    expect(markers.map((m) => m.data?.kind)).toEqual(["proactive", "reply"]);
    const midRun = entries.indexOf(markers[0]!);
    expect(entries[midRun - 1]!.message?.role).toBe("toolResult");
    expect(entries[midRun + 1]!.message?.role).toBe("assistant");
    expect(entries.at(-1)).toBe(markers[1]!);

    const page = chatHistoryResult.parse(reader.page({ limit: 40 }));
    expect(page.before).toBeNull();
    expect(page.items).toEqual([
      { type: "user", id: expect.any(String), clientId: "01J00000000000000000000001", at: expect.any(String), text: "list my home", attachments: [] },
      { type: "assistant", id: expect.any(String), at: expect.any(String), text: "", tools: [{ name: "ls", summary: ".", ok: true }] },
      { type: "assistant", id: expect.any(String), at: expect.any(String), text: "mid-run ping", outboxId: delivered[0]!.outboxId, tools: [] },
      {
        type: "assistant",
        id: expect.any(String),
        at: expect.any(String),
        text: "here are the files",
        outboxId: delivered[1]!.outboxId,
        turnId: delivered[1]!.turnId,
        usage: delivered[1]!.usage,
        tools: [],
      },
    ]);
    await personal.dispose();
  }, 20_000);

  test("chat/new starts a new file marked new; history pages back across the boundary", async () => {
    const { personal, delivered, reader } = await host();
    script({ text: "first answer" });
    await personal.handleMessage(web("01J00000000000000000000001", "first"));
    await until(() => delivered.length === 1);
    const oldFile = personal.currentSessionFile;
    await personal.handleNew();
    script({ text: "second answer" });
    await personal.handleMessage(web("01J00000000000000000000002", "second"));
    await until(() => delivered.length === 2);

    expect(personal.currentSessionFile).not.toBe(oldFile);
    expect(linesOf(personal.currentSessionFile).find((e) => e.customType === SESSION_ENTRY)?.data).toEqual({ reason: "new" });

    const newest = chatHistoryResult.parse(reader.page({ limit: 2 }));
    expect(newest.items.map((i) => (i.type === "assistant" || i.type === "user" ? i.text : i.type))).toEqual(["second", "second answer"]);
    const older = chatHistoryResult.parse(reader.page({ before: newest.before!, limit: 40 }));
    expect(older.items.map((i) => (i.type === "divider" ? `divider:${i.kind}` : i.type === "ask" ? i.question : i.text))).toEqual(["first", "first answer", "divider:new"]);
    expect(older.before).toBeNull();
    await personal.dispose();
  }, 20_000);
});
