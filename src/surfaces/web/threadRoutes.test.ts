import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { WebInboundStore } from "./inbound.ts";
import { WebWorkspaceAdapter } from "./workspaceAdapter.ts";
import { createPresence } from "./presence.ts";
import { createChatRoutes } from "./chatRoutes.ts";
import { WebThreads } from "./threadRoutes.ts";
import { mintWebActor } from "./actor.ts";
import type {
  ChatMessageParams,
  ChatOrigin,
} from "../../orchestration/contracts.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const actor = mintWebActor("owner@example.com", "Owner");
function setup() {
  const db = new Database(":memory:");
  applySchema(db);
  const log = new SqliteChatLog(db);
  const inbound = new WebInboundStore(db);
  const presence = createPresence({ head: () => log.head() });
  const adapter = new WebWorkspaceAdapter({ log, inbound, presence });
  const sent: Omit<ChatMessageParams, "principalId">[] = [];
  const controls: (ChatOrigin | undefined)[] = [];
  const managed: { id: string; action: string }[] = [];
  let held = false;
  const link = {
    isConnected: () => true,
    sendMessage: async (p: Omit<ChatMessageParams, "principalId">) => {
      sent.push(p);
      return { accepted: true as const, mode: "prompt" as const };
    },
    topicManage: async (p: { id: string; action: string }) => {
      if (held && p.action === "close") throw new Error("stop work first");
      managed.push(p);
    },
    abort: async (_id?: string, o?: ChatOrigin) => {
      controls.push(o);
      return { aborted: true };
    },
    newSession: async (o?: ChatOrigin) => {
      controls.push(o);
      return { sessionFile: "s" };
    },
    recordOffline: () => {},
    interceptReply: async () => ({ handled: false as const }),
    isOwner: () => true,
    isLoginPending: () => false,
    startLogin: async () => ({ status: "started" as const }),
    completeLogin: async () => ({ status: "ok" as const }),
    cancelLogin: async () => ({ status: "cancelled" as const }),
    command: async (_c: unknown, _a?: string, o?: ChatOrigin) => {
      controls.push(o);
      return { text: "compacted" };
    },
    stopTurn: async (o: ChatOrigin) => {
      controls.push(o);
      return { status: "ok" as const, aborted: true, final: null };
    },
    answerAsk: async () => ({ status: "answered" as const, answer: "yes" }),
  };
  const tools = { decide: () => "decided" as const };
  const chat = { link, tools, workspaceEnabled: true };
  const routes = createChatRoutes({ ...chat, log, inbound, adapter, presence });
  const threads = new WebThreads({
    db,
    main: { log, adapter, routes },
    link,
    chat,
    adapter: {},
  });
  cleanups.push(() => {
    routes.closeStreams();
    threads.closeStreams();
    adapter.close();
    db.close();
  });
  const call = async (path: string, body?: unknown) =>
    threads.handle(
      new Request(`https://agent.example${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      path,
      actor,
    );
  const create = async () =>
    (await (await call("/api/threads", {
      messageId: "",
      title: "Trip",
    }))!.json()) as { id: string };
  return {
    db,
    log,
    threads,
    call,
    create,
    sent,
    controls,
    managed,
    hold: () => {
      held = true;
    },
  };
}

test("topic history, replay, approvals and idempotency keys are isolated from Main", async () => {
  const h = setup();
  const { id } = await h.create();
  const topic = h.threads.channel(id).log;
  h.log.append("reply", { key: "same", text: "Main only", files: [] }, "same");
  topic.append("reply", { key: "same", text: "Topic only", files: [] }, "same");
  const mainReplay: string[] = [];
  const topicReplay: string[] = [];
  const a = h.log.subscribe(0, (e) => {
    if (e.type === "reply") mainReplay.push(e.data.text);
  });
  const b = topic.subscribe(0, (e) => {
    if (e.type === "reply") topicReplay.push(e.data.text);
  });
  expect(mainReplay).toEqual(["Main only"]);
  expect(topicReplay).toEqual(["Topic only"]);
  expect(topic.page(["reply"], { limit: 10 }).map((e) => e.data.text)).toEqual([
    "Topic only",
  ]);
  a.close();
  b.close();
  const again = new SqliteChatLog(h.db, { conversationId: id });
  expect(again.find("reply", "same")?.data.text).toBe("Topic only");
});

test("messages and controls use the topic origin; archived topics resume on the next message without reporting to Main", async () => {
  const h = setup();
  const { id } = await h.create();
  const base = `/api/threads/${id}`;
  const r = await h.call(`${base}/chat/messages`, {
    clientId: "01J9Z3W8K2M4N6P8Q0R2S4T6V8",
    text: "Book the trip",
  });
  expect(r?.status).toBe(202);
  await h.threads.channel(id).routes.idle();
  expect(h.sent[0]?.origin.conversationId).toBe(id);
  expect(h.log.page(["user"], { limit: 10 })).toHaveLength(0);
  await h.call(`${base}/chat/stop`, {});
  await new Promise((r) => setImmediate(r));
  expect(h.controls[0]?.conversationId).toBe(id);
  await h.call(`${base}/close`, {});
  expect(h.log.page(["proactive"], { limit: 10 })).toHaveLength(0);
  expect((await (await h.call(base))!.json()).summary.state).toBe("archived");
  expect(
    (
      await h.call(`${base}/chat/messages`, {
        clientId: "01J9Z3W8K2M4N6P8Q0R2S4T6V9",
        text: "later",
      })
    )?.status,
  ).toBe(202);
  await h.threads.channel(id).routes.idle();
  expect(h.managed.at(-1)?.action).toBe("reopen");
  expect((await (await h.call(base))!.json()).summary.state).toBe("idle");
});

test("the surface retains the topic on progress and approval handles", async () => {
  const h = setup();
  const { id } = await h.create();
  const surface = h.threads.surface();
  const origin = { surface: "web", conversationId: id };
  const view = {
    turnId: "topic-turn",
    startedAt: Date.now(),
    text: "",
    lines: [],
    toolCount: 0,
  };
  const handle = await surface.progressCreate(origin, view);
  await surface.progressDelta(handle, "Hello topic", view);
  await surface.progressFinalize(origin, handle, {
    outcome: "done",
    summary: null,
  });
  await surface.sendReply(
    origin,
    { kind: "reply", toolCount: 0, text: "Final topic", files: [] },
    {
      outboxId: "topic-reply",
      plain: false,
      ledger: { isSent: () => false, markSent: () => {} },
    },
  );
  expect(
    h.threads.channel(id).log.find("reply", "topic-reply")?.data.text,
  ).toBe("Final topic");
  expect(h.log.find("reply", "topic-reply")).toBeNull();
});

test("closing work still in progress leaves metadata active", async () => {
  const h = setup();
  const { id } = await h.create();
  h.hold();
  await expect(h.call(`/api/threads/${id}/close`, {})).rejects.toThrow(
    "stop work first",
  );
  expect(
    (await (await h.call(`/api/threads/${id}`))!.json()).summary.state,
  ).toBe("idle");
});

test("more than eight persistent threads can be created and resumed", async () => {
  const h = setup();
  const ids = await Promise.all(Array.from({ length: 10 }, () => h.create()));
  expect(new Set(ids.map((t) => t.id)).size).toBe(10);
  const base = `/api/threads/${ids[0]!.id}`;
  await h.call(`${base}/close`, {});
  expect((await h.call(`${base}/reopen`, {}))?.status).toBe(200);
});

test("seven idle days move a thread into Archived without deleting history", async () => {
  const h = setup();
  const { id } = await h.create();
  h.db.run("UPDATE web_threads SET created_at = ? WHERE id = ?", [
    Date.now() - 8 * 86400000,
    id,
  ]);
  await h.threads.prune();
  const detail = await (await h.call(`/api/threads/${id}`))!.json();
  expect(detail.summary.state).toBe("archived");
  expect(detail.summary.archived.by).toBe("idle");
  expect(h.log.page(["proactive"], { limit: 10 })).toHaveLength(0);
});

test("pending questions keep inactive threads current", async () => {
  const h = setup();
  const { id } = await h.create();
  h.db.run("UPDATE web_threads SET created_at = ? WHERE id = ?", [
    Date.now() - 8 * 86400000,
    id,
  ]);
  h.threads
    .channel(id)
    .log.append(
      "ask",
      {
        key: "waiting",
        askId: "waiting",
        question: "Which topic?",
        choices: [],
      },
      "waiting",
    );
  await h.threads.prune();
  const detail = await (await h.call(`/api/threads/${id}`))!.json();
  expect(detail.summary.state).toBe("needs-you");
  expect(h.managed.filter((m) => m.action === "close")).toHaveLength(0);
  await expect(h.call(`/api/threads/${id}/close`, {})).rejects.toThrow(
    "pending requests",
  );
});
