import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatHistoryReader, HistoryCursorError, chatHistoryHandlers, convertSession, type OpenFile } from "./chatHistory.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { chatHistoryResult, type HistoryItem } from "../orchestration/contracts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function agentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-chat-history-"));
  dirs.push(d);
  mkdirSync(join(d, "chat"));
  return d;
}

type E = Record<string, unknown>;
let seq = 0;
const at = () => new Date(Date.UTC(2026, 8, 30, 12, 0, seq)).toISOString();
const user = (text: string, extra: E = {}): E => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const assistant = (content: unknown[], stopReason = "stop"): E => ({ type: "message", message: { role: "assistant", content, stopReason } });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, isError = false): E => ({ type: "message", message: { role: "toolResult", toolCallId, toolName: "bash", content: [text("out")], isError } });
const delivery = (data: E): E => ({ type: "custom", customType: "sushii.delivery", data });

/** Writes a session file whose entries chain linearly, as Pi appends them. */
function session(dir: string, base: string, entries: E[], header: E = {}): string {
  let parentId: string | null = null;
  const lines = [{ type: "session", version: 3, id: base, timestamp: at(), cwd: "/home", ...header }];
  for (const [i, e] of entries.entries()) {
    const id = (e.id as string | undefined) ?? `${base.slice(-4)}${String(i).padStart(4, "0")}`;
    lines.push({ parentId: "parentId" in e ? (e.parentId as string | null) : parentId, timestamp: at(), ...e, id } as never);
    parentId = id;
    seq++;
  }
  const file = join(dir, "chat", `${base}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const WEB = (clientId: string, body: string) => `[web:${clientId} 2026-09-30 12:34 UTC]\n${body}`;
const labels = (items: HistoryItem[]) =>
  items.map((i) => (i.type === "divider" ? `divider:${i.kind}` : i.type === "ask" ? `ask:${i.question}` : `${i.type}:${i.text}`));

describe("convertSession", () => {
  test("an owner turn, its tools and its reply marker become one user and one assistant item", () => {
    const d = agentDir();
    const file = session(d, "s1", [
      user(WEB("01J00000000000000000000001", "check disk")),
      assistant([text("let me look"), call("c1", "bash", { command: "df -h" }), call("c2", "read", { path: "x" })], "toolUse"),
      result("c1"),
      result("c2", true),
      assistant([text("80% used")]),
      delivery({ outboxId: "ob1", kind: "reply", turnId: "t1", usage: { model: "m", inputTokens: 1, outputTokens: 2 } }),
    ]);
    const { items } = convertSession(readFileSync(file, "utf8"), "s1");
    expect(items).toEqual([
      { type: "user", id: "s1:s10000", clientId: "01J00000000000000000000001", at: "2026-09-30T12:34:00.000Z", text: "check disk", attachments: [] },
      {
        type: "assistant",
        id: "s1:s10001",
        at: expect.any(String),
        text: "80% used",
        outboxId: "ob1",
        turnId: "t1",
        usage: { model: "m", inputTokens: 1, outputTokens: 2 },
        tools: [
          { name: "bash", summary: "df -h", ok: true },
          { name: "read", summary: "x", ok: false },
        ],
      },
    ]);
  });

  test("flush turns, wakes' prompts, context, recap and bookkeeping entries stay out; the wake's reply stays in", () => {
    const d = agentDir();
    const file = session(d, "s1", [
      { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "model_change", provider: "p", modelId: "m" },
      { type: "custom_message", customType: "workspace_recap", content: "Recap of our previous session", display: true },
      { type: "custom_message", customType: "workspace_context", content: "[discord:9 2026-09-30 12:00 UTC]\nguild chatter", display: true },
      user(`${FLUSH_MARKER} write memory`),
      assistant([call("f1", "edit", { path: "MEMORY.md" })], "toolUse"),
      result("f1"),
      assistant([text("NO_REPLY")]),
      user('<subagent-result run="r1">\nfound it\n</subagent-result>'),
      assistant([text("the subagent found it")]),
      { type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: {} },
      { type: "label", targetId: "x", label: "l" },
      { type: "context_edit", targetId: "s10003", replacement: null },
      { type: "custom", customType: "other-extension", data: { text: "state" } },
      { type: "session_info", name: "n" },
    ]);
    const { items, reason } = convertSession(readFileSync(file, "utf8"), "s1");
    expect(labels(items)).toEqual(["assistant:the subagent found it"]);
    expect(reason).toBe("rotated");
  });

  test("user text loses the header, Pi's image notes and inline image data; attachment lines become attachments", () => {
    const d = agentDir();
    const upload = "AbCdEfGhIjKlMnOpQrStUv";
    const body = [
      WEB("01J00000000000000000000002", "two photos"),
      `[attachment: cat (1).jpg (image/jpeg) upload:${upload} → ~/uploads/${upload}.jpg]`,
      "[attachment: old.png (image/png) https://cdn.discordapp.com/attachments/1/2/old.png]",
      "",
      "[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]",
    ].join("\n");
    const file = session(d, "s1", [
      { type: "message", message: { role: "user", content: [{ type: "text", text: body }, { type: "image", data: "QkFTRTY0SU1BR0U=", mimeType: "image/jpeg" }] } },
      user("[discord:175928847299117063 2016-04-30 11:18 UTC, voice message, transcribed]\nremind me"),
      user(`[message]\n${FLUSH_MARKER} not really`),
      assistant([text("escaped prompts aren't flushes")]),
    ]);
    const raw = readFileSync(file, "utf8");
    const { items } = convertSession(raw, "s1");
    expect(JSON.stringify(items)).not.toContain("QkFTRTY0SU1BR0U=");
    expect(items[0]).toMatchObject({
      text: "two photos",
      attachments: [
        { uploadId: upload, name: "cat (1).jpg", contentType: "image/jpeg" },
        { name: "old.png", contentType: "image/png" },
      ],
    });
    expect(items[1]).toEqual({ type: "user", id: "s1:s10001", at: "2016-04-30T11:18:00.000Z", text: "remind me", attachments: [] });
    // Header-less, so not an owner bubble; escaped, so not a flush either: its reply shows.
    expect(labels(items.slice(2))).toEqual(["assistant:escaped prompts aren't flushes"]);
    expect("clientId" in items[1]!).toBe(false);
  });

  test("proactive, failure and ask markers stand alone; auth markers and aborted text don't show", () => {
    const d = agentDir();
    const file = session(d, "s1", [
      delivery({ outboxId: "p1", kind: "proactive", text: "morning brief" }),
      user(WEB("01J00000000000000000000003", "go")),
      assistant([text("partial")], "aborted"),
      assistant([text("")], "error"),
      delivery({ outboxId: "f1", kind: "reply", turnId: "t2", text: "⚠️ Turn failed: boom" }),
      delivery({ outboxId: "a1", kind: "ask", text: "Keep?", ask: { askId: "k1", question: "Keep?", choices: ["Keep", "Drop"] } }),
      delivery({ outboxId: "l1", kind: "auth" }),
      delivery({ outboxId: "x".repeat(300), kind: "proactive", text: "oversized id" }),
    ]);
    const { items } = convertSession(readFileSync(file, "utf8"), "s1");
    expect(labels(items)).toEqual(["assistant:morning brief", "user:go", "assistant:⚠️ Turn failed: boom", "ask:Keep?"]);
    expect(items[3]).toEqual({ type: "ask", id: "s1:s10005", at: expect.any(String), outboxId: "a1", askId: "k1", question: "Keep?", choices: ["Keep", "Drop"] });
  });

  test("an ask mid-run sits between the output before it and the reply after it", () => {
    const d = agentDir();
    const file = session(d, "s1", [
      user(WEB("01J00000000000000000000005", "send me the report")),
      assistant([call("c1", "send_file", { path: "r.pdf" })], "toolUse"),
      delivery({ outboxId: "a1", kind: "ask", turnId: "t1", text: "Send r.pdf?", ask: { askId: "k1", question: "Send r.pdf?", choices: ["Yes", "No"] } }),
      result("c1"),
      assistant([text("sent")]),
      delivery({ outboxId: "r1", kind: "reply", turnId: "t1" }),
    ]);
    const { items } = convertSession(readFileSync(file, "utf8"), "s1");
    expect(labels(items)).toEqual(["user:send me the report", "assistant:", "ask:Send r.pdf?", "assistant:sent"]);
    expect(items[1]).toMatchObject({ tools: [{ name: "send_file", ok: true }] });
    expect(items[3]).toMatchObject({ outboxId: "r1", turnId: "t1" });
  });

  test("the reply text is the last assistant message's, as the host delivers it: an empty or failed final message leaves none", () => {
    const d = agentDir();
    const file = session(d, "s1", [
      user(WEB("01J00000000000000000000006", "check")),
      assistant([text("Let me check"), call("c1", "bash", { command: "ls" })], "toolUse"),
      result("c1"),
      assistant([], "stop"),
      user(WEB("01J00000000000000000000007", "again")),
      assistant([text("Looking"), call("c2", "bash", { command: "ls" })], "toolUse"),
      result("c2"),
      assistant([text("half an answer")], "error"),
      user(WEB("01J00000000000000000000008", "last")),
      assistant([text("Checking"), call("c3", "bash", { command: "ls" })], "toolUse"),
      result("c3"),
      assistant([text("done")]),
    ]);
    const { items } = convertSession(readFileSync(file, "utf8"), "s1");
    expect(labels(items)).toEqual(["user:check", "assistant:", "user:again", "assistant:", "user:last", "assistant:done"]);
    expect(items[1]).toMatchObject({ tools: [{ name: "bash", ok: true }] });
  });

  test("a compaction is a collapsed divider; only the leaf's branch is shown; a torn last line is skipped", () => {
    const d = agentDir();
    const file = session(d, "s1", [
      user(WEB("01J00000000000000000000004", "first")),
      { id: "dead0001", ...assistant([text("abandoned branch")]) },
      { id: "live0001", parentId: "s10000", ...assistant([text("kept branch")]) },
      { type: "compaction", summary: "## Goal\nstuff", firstKeptEntryId: "live0001", tokensBefore: 1 },
    ]);
    appendFileSync(file, '{"type":"message","id":"torn');
    const { items } = convertSession(readFileSync(file, "utf8"), "s1");
    expect(labels(items)).toEqual(["user:first", "assistant:kept branch", "divider:compacted"]);
    expect(items[2]).toMatchObject({ summary: "## Goal\nstuff" });
  });
});

describe("ChatHistoryReader", async () => {
  function threeSessions() {
    const d = agentDir();
    session(d, "2026-09-28T10-00-00-000Z_a", [user(WEB("01J0000000000000000000000A", "a1")), assistant([text("A1")])]);
    session(d, "2026-09-29T10-00-00-000Z_b", [
      { type: "custom", customType: "sushii.session", data: { reason: "rotated" } },
      user(WEB("01J0000000000000000000000B", "b1")),
      assistant([text("B1")]),
    ]);
    session(d, "2026-09-30T10-00-00-000Z_c", [
      { type: "custom", customType: "sushii.session", data: { reason: "new" } },
      user(WEB("01J0000000000000000000000C", "c1")),
      assistant([text("C1")]),
    ]);
    return d;
  }

  test("pages walk back through session files, oldest first within a page, with a divider at each boundary", async () => {
    const reader = new ChatHistoryReader({ agentDir: threeSessions() });
    const pages: HistoryItem[][] = [];
    let before: string | undefined;
    for (;;) {
      const page = chatHistoryResult.parse(await reader.page({ before, limit: 2 }));
      pages.push(page.items);
      if (page.before === null) break;
      expect(page.before).toBe(page.items[0]!.id);
      before = page.before;
    }
    expect(pages.map(labels)).toEqual([["user:c1", "assistant:C1"], ["assistant:B1", "divider:new"], ["divider:rotated", "user:b1"], ["user:a1", "assistant:A1"]]);
    expect(pages[1]![1]).toMatchObject({ id: "2026-09-30T10-00-00-000Z_c:start", type: "divider" });
  });

  test("a page never exceeds the byte budget, but always holds at least one item", async () => {
    const d = agentDir();
    session(d, "s1", [user(WEB("01J00000000000000000000001", "x".repeat(600))), assistant([text("y".repeat(600))])]);
    const reader = new ChatHistoryReader({ agentDir: d, maxBytes: 1000 });
    const first = await reader.page({ limit: 40 });
    expect(labels(first.items)).toEqual([`assistant:${"y".repeat(600)}`]);
    expect(first.before).toBe("s1:s10001");
    const second = await reader.page({ before: first.before!, limit: 40 });
    expect(second.items.length).toBe(1);
    expect(second.before).toBeNull();
  });

  test("a cursor naming an unknown file or entry is an error, never a fallback to the newest page", async () => {
    const reader = new ChatHistoryReader({ agentDir: threeSessions() });
    for (const before of ["nope:abc", "../../etc/passwd:x", "2026-09-30T10-00-00-000Z_c:ffffffff", "no-colon", "2026-09-30T10-00-00-000Z_c"]) {
      await expect(reader.page({ before, limit: 5 })).rejects.toThrow(HistoryCursorError);
    }
  });

  test("an empty or missing chat dir is an empty history", async () => {
    const d = mkdtempSync(join(tmpdir(), "ws-chat-history-"));
    dirs.push(d);
    expect(await new ChatHistoryReader({ agentDir: d }).page({ limit: 5 })).toEqual({ items: [], before: null });
  });

  test("a symlink in chat/ pointing outside the session roots is not read", async () => {
    const d = agentDir();
    const outside = mkdtempSync(join(tmpdir(), "ws-chat-outside-"));
    dirs.push(outside);
    mkdirSync(join(outside, "chat"));
    session(outside, "evil", [user(WEB("01J00000000000000000000009", "secret"))]);
    symlinkSync(join(outside, "chat", "evil.jsonl"), join(d, "chat", "evil.jsonl"));
    expect((await new ChatHistoryReader({ agentDir: d }).page({ limit: 5 })).items).toEqual([]);
  });

  /** Wraps the reader's file opening so a test can count reads, fail a file, or act between open and read. */
  function openSeam(hook: { fail?: (path: string) => boolean; afterOpen?: (path: string) => void; bytes?: { n: number } } = {}): OpenFile {
    return async (path, flags) => {
      if (hook.fail?.(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      const fh = await open(path, flags);
      hook.afterOpen?.(path);
      if (hook.bytes) {
        const read = fh.read.bind(fh) as (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
        (fh as unknown as { read: unknown }).read = async (...args: unknown[]) => {
          const r = await read(...args);
          hook.bytes!.n += r.bytesRead;
          return r;
        };
      }
      return fh;
    };
  }

  const assistantLine = (id: string, parentId: string, body: string) =>
    JSON.stringify({ type: "message", id, parentId, timestamp: at(), message: { role: "assistant", content: [text(body)], stopReason: "stop" } }) + "\n";

  test("a file that grows is read only past what was already parsed; an unchanged one comes from the cache", async () => {
    const d = agentDir();
    const file = session(d, "s1", [user(WEB("01J00000000000000000000001", "one")), assistant([text("x".repeat(50_000))])]);
    const bytes = { n: 0 };
    const reader = new ChatHistoryReader({ agentDir: d, open: openSeam({ bytes }) });
    const first = await reader.page({ limit: 5 });
    expect(labels(first.items)).toEqual(["user:one", `assistant:${"x".repeat(50_000)}`]);
    expect((await reader.page({ limit: 5 })).items[0]).toBe(first.items[0]!);

    bytes.n = 0;
    const line = assistantLine("late0001", "s10001", "two");
    // A write in progress: the partial line waits, then the rest of it is read on the next page.
    appendFileSync(file, line.slice(0, 20));
    expect(labels((await reader.page({ limit: 5 })).items).at(-1)).toBe(`assistant:${"x".repeat(50_000)}`);
    appendFileSync(file, line.slice(20));
    expect(labels((await reader.page({ limit: 5 })).items)).toEqual(["user:one", "assistant:two"]);
    expect(bytes.n).toBeLessThan(2_000);
  });

  test("a file rewritten in place, even to a larger size, is parsed again from the start", async () => {
    const d = agentDir();
    const file = session(d, "s1", [user(WEB("01J00000000000000000000001", "one")), assistant([text("first")])]);
    const reader = new ChatHistoryReader({ agentDir: d });
    expect(labels((await reader.page({ limit: 5 })).items)).toEqual(["user:one", "assistant:first"]);
    const raw = readFileSync(file, "utf8").replace('"first"', '"FIRST"');
    writeFileSync(file, raw + assistantLine("late0001", "s10001", "later"));
    expect(labels((await reader.page({ limit: 5 })).items)).toEqual(["user:one", "assistant:later"]);
    writeFileSync(file, raw);
    expect(labels((await reader.page({ limit: 5 })).items)).toEqual(["user:one", "assistant:FIRST"]);
  });

  test("a file that can't be read is left out without failing the page; a cursor into it is an unknown cursor", async () => {
    const d = threeSessions();
    let failing = "2026-09-29T10-00-00-000Z_b";
    const reader = new ChatHistoryReader({ agentDir: d, open: openSeam({ fail: (p) => p.includes(failing) }) });
    const page = await reader.page({ limit: 40 });
    expect(labels(page.items)).toEqual(["user:a1", "assistant:A1", "divider:new", "user:c1", "assistant:C1"]);
    await expect(reader.page({ before: "2026-09-29T10-00-00-000Z_b:0Z_b0001", limit: 5 })).rejects.toThrow(HistoryCursorError);

    failing = "none";
    const cursor = (await reader.page({ limit: 40 })).items.find((i) => i.id === "2026-09-29T10-00-00-000Z_b:0Z_b0001")!.id;
    rmSync(join(d, "chat", "2026-09-29T10-00-00-000Z_b.jsonl"));
    await expect(reader.page({ before: cursor, limit: 5 })).rejects.toThrow("unknown history cursor");
    expect(labels((await reader.page({ limit: 40 })).items)).toEqual(["user:a1", "assistant:A1", "divider:new", "user:c1", "assistant:C1"]);
  });

  test("reads come from the descriptor that was vetted, not the path re-opened after a swap", async () => {
    const d = agentDir();
    const file = session(d, "s1", [user(WEB("01J00000000000000000000001", "real"))]);
    const decoy = join(d, "decoy.jsonl");
    writeFileSync(decoy, readFileSync(file, "utf8").replace('real"', 'decoy"'));
    const reader = new ChatHistoryReader({ agentDir: d, open: openSeam({ afterOpen: () => renameSync(decoy, file) }) });
    expect(labels((await reader.page({ limit: 5 })).items)).toEqual(["user:real"]);
  });
});

describe("chat/history handler", () => {
  test("parses params, checks the principal, and answers a page", async () => {
    const d = agentDir();
    session(d, "s1", [user(WEB("01J00000000000000000000001", "hi"))]);
    const handler = chatHistoryHandlers({ principalId: "drk", reader: new ChatHistoryReader({ agentDir: d }) })["chat/history"]!;
    expect(chatHistoryResult.parse(await handler({ principalId: "drk" })).items.length).toBe(1);
    await expect(handler({ principalId: "someone" })).rejects.toThrow("principal mismatch");
    await expect(handler({ principalId: "drk", limit: 500 })).rejects.toThrow();
  });
});
