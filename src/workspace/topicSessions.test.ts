import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicSessions, type TopicSession } from "./topicSessions.ts";
import {
  RPC_METHODS,
  chatMessageParams,
  chatAckParams,
  type ChatMessageParams,
  type ChatMessageResult,
} from "../orchestration/contracts.ts";

class FakeSession implements TopicSession {
  messages: ChatMessageParams[] = [];
  idle = true;
  disposed = false;
  archives = 0;
  stops = 0;
  starts = 0;
  features: readonly string[] = [];
  outbox = new Set<string>();
  get state(): "streaming" | "idle" {
    return this.idle ? "idle" : "streaming";
  }
  async start() {
    this.starts++;
  }
  onRegistered(f: readonly string[]) {
    this.features = f;
  }
  async handleMessage(p: ChatMessageParams): Promise<ChatMessageResult> {
    this.messages.push(p);
    return {
      accepted: true,
      mode: p.kind === "context" ? "context" : "prompt",
    };
  }
  async prepareArchive() {
    this.archives++;
  }
  async compactNow() {
    return { tokensBefore: 10, tokensAfter: 2 };
  }
  currentTurnId() {
    return this.idle ? "" : "topic-turn";
  }
  requestContextReload() {}
  isIdle() {
    return this.idle;
  }
  async dispose() {
    this.disposed = true;
  }
  wake() {}
  ownsDelivery(id: string) {
    return this.outbox.has(id);
  }
  hasUnackedDeliveries() {
    return this.outbox.size > 0;
  }
  handlers(): Record<string, (p: unknown) => Promise<unknown>> {
    return {
      [RPC_METHODS.chatMessage]: async (p) =>
        this.handleMessage(chatMessageParams.parse(p)),
      [RPC_METHODS.chatAbort]: async () => {
        this.stops++;
        return { aborted: true };
      },
      [RPC_METHODS.chatNew]: async () => ({ sessionFile: "new" }),
      [RPC_METHODS.chatAck]: async (p) => {
        this.outbox.delete(chatAckParams.parse(p).outboxId);
        return {};
      },
    };
  }
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(stateDir = mkdtempSync(join(tmpdir(), "topic-session-test-"))) {
  dirs.push(stateDir);
  const main = new FakeSession();
  const created = new Map<string, FakeSession>();
  const manager = new TopicSessions({
    principalId: "owner",
    stateDir,
    main,
    create: (id) => {
      const s = new FakeSession();
      created.set(id, s);
      return s;
    },
    command: async () => ({ text: "global command" }),
  });
  const create = (id: string) =>
    manager.manage({
      principalId: "owner",
      id,
      action: "create",
      title: id,
      brief: "Main facts",
    });
  const message = (id: string): ChatMessageParams => ({
    principalId: "owner",
    origin: { surface: "web", conversationId: id },
    messageId: `m:${id}`,
    text: id,
    kind: "user",
    author: { id: "owner", name: "Owner" },
  });
  return { manager, main, created, create, message, stateDir };
}

test("topic sessions have independent messages and controls, and refuse unknown origins", async () => {
  const h = setup();
  await h.create("trip");
  await h.create("mail");
  const handlers = h.manager.handlers();
  await handlers[RPC_METHODS.chatMessage]!(h.message("trip"));
  await handlers[RPC_METHODS.chatMessage]!(h.message("mail"));
  await handlers[RPC_METHODS.chatMessage]!(h.message("main"));
  expect(h.created.get("trip")!.messages.map((m) => m.kind)).toEqual([
    "context",
    "user",
  ]);
  expect(h.main.messages).toHaveLength(1);
  await handlers[RPC_METHODS.chatAbort]!({
    principalId: "owner",
    origin: h.message("trip").origin,
  });
  expect(h.created.get("trip")!.stops).toBe(1);
  expect(h.created.get("mail")!.stops).toBe(0);
  expect(h.main.stops).toBe(0);
  await expect(
    handlers[RPC_METHODS.chatMessage]!(h.message("missing")),
  ).rejects.toThrow("unknown topic");
  await expect(
    handlers[RPC_METHODS.chatMessage]!({
      ...h.message("trip"),
      principalId: "stranger",
    }),
  ).rejects.toThrow("principal mismatch");
});

test("archive saves memory without replacing the conversation; active work cannot close", async () => {
  const h = setup();
  await h.create("trip");
  const s = h.created.get("trip")!;
  s.idle = false;
  await expect(
    h.manager.manage({ principalId: "owner", id: "trip", action: "close" }),
  ).rejects.toThrow("Stop the thread");
  s.idle = true;
  s.outbox.add("reply");
  await h.manager.manage({ principalId: "owner", id: "trip", action: "close" });
  expect(s.archives).toBe(1);
  expect(s.messages).toHaveLength(1);
  expect(s.disposed).toBe(false);
  await h.manager.handlers()[RPC_METHODS.chatAck]!({ outboxId: "reply" });
  expect(s.disposed).toBe(true);
  expect(await h.manager.session(h.message("trip").origin)).toBe(
    h.created.get("trip")!,
  );
});

test("a restart restores active topics, keeps archived ones lazy and restores an unsaved brief", async () => {
  const h = setup();
  await h.create("trip");
  await h.create("mail");
  await h.manager.manage({ principalId: "owner", id: "mail", action: "close" });
  await h.manager.dispose();
  const restored = setup(h.stateDir);
  await restored.manager.restore();
  expect([...restored.created.keys()]).toEqual(["trip"]);
  expect(restored.created.get("trip")!.messages[0]?.text).toContain(
    "Main facts",
  );
});

test("concurrent topic creation has no active limit and rejects path traversal", async () => {
  const h = setup();
  const results = await Promise.allSettled(
    Array.from({ length: 9 }, (_, i) => h.create(`topic-${i}`)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(9);
  await expect(h.create("../escape")).rejects.toThrow();
  await expect(h.create("main")).rejects.toThrow();
});
