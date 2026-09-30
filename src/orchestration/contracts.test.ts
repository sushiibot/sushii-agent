import { describe, expect, test } from "bun:test";
import {
  chatDeliverParams,
  chatHistoryParams,
  chatHistoryResult,
  historyItem,
  ID_MAX,
  isHttpsUrl,
  parseUploadUrl,
  RPC_METHODS,
  UPLOAD_MAX_BYTES,
  uploadReadParams,
  uploadReadResult,
  uploadUrl,
  webChatOrigin,
  webConversationId,
} from "./contracts.ts";

const UID = "AbCdEfGhIjKlMnOpQrSt_-";
const long = "x".repeat(ID_MAX + 1);

const HTTPS_ACCEPT = ["https://auth.openai.com/oauth/authorize?state=s1", "HTTPS://Auth.OpenAI.com/x", "https://example.com:8443/a#b"];
const HTTPS_REJECT = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  " javascript:alert(1)",
  "\u0000javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "http://auth.openai.com/x",
  "ftp://example.com/x",
  "//auth.openai.com/x",
  "/relative/path",
  "auth.openai.com/x",
  "",
];

describe("isHttpsUrl", () => {
  test.each(HTTPS_ACCEPT)("accepts %p", (url) => expect(isHttpsUrl(url)).toBe(true));
  test.each(HTTPS_REJECT)("rejects %p", (url) => expect(isHttpsUrl(url)).toBe(false));
});

describe("chat/deliver auth url", () => {
  const auth = (url: string) => ({ outboxId: "o1", principalId: "drk", kind: "auth", text: "Sign in", auth: { url, instructions: "paste" } });

  test.each(HTTPS_ACCEPT)("accepts %p", (url) => expect(chatDeliverParams.safeParse(auth(url)).success).toBe(true));
  test.each(HTTPS_REJECT)("rejects %p", (url) => expect(chatDeliverParams.safeParse(auth(url)).success).toBe(false));

  test("rejects a URL over 4096 chars", () => {
    expect(chatDeliverParams.safeParse(auth(`https://a.example/${"x".repeat(4096)}`)).success).toBe(false);
  });
});

describe("web conversation id", () => {
  test("only main", () => {
    expect(webConversationId.safeParse("main").success).toBe(true);
    for (const id of ["Main", "main ", "", "schedule", "123456789012345678"]) expect(webConversationId.safeParse(id).success).toBe(false);
  });

  test("web origin needs surface web and conversation main", () => {
    expect(webChatOrigin.safeParse({ surface: "web", conversationId: "main" }).success).toBe(true);
    expect(webChatOrigin.safeParse({ surface: "discord", conversationId: "main" }).success).toBe(false);
    expect(webChatOrigin.safeParse({ surface: "web", conversationId: "other" }).success).toBe(false);
  });
});

describe("upload urls", () => {
  test("round-trips a valid id", () => {
    expect(uploadUrl(UID)).toBe(`upload:${UID}`);
    expect(parseUploadUrl(uploadUrl(UID))).toBe(UID);
  });

  test.each([
    "https://cdn.discordapp.com/x.png",
    `upload:${UID}x`,
    `upload:${UID.slice(1)}`,
    "upload:../../etc/passwd_aaaaaaaaaaa",
    "upload:AbCdEfGhIjKlMnOpQrSt/-",
    `UPLOAD:${UID}`,
    ` upload:${UID}`,
  ])("rejects %p", (url) => expect(parseUploadUrl(url)).toBeNull());
});

describe("chat/history params", () => {
  test("method name", () => expect(RPC_METHODS.chatHistory).toBe("chat/history"));

  test("defaults limit to 40 and allows no cursor", () => {
    expect(chatHistoryParams.parse({ principalId: "drk" })).toEqual({ principalId: "drk", limit: 40 });
  });

  test("accepts a cursor and limits 1..100", () => {
    expect(chatHistoryParams.safeParse({ principalId: "drk", before: "2026-09-30T00-00-00_abc:e1f2", limit: 1 }).success).toBe(true);
    expect(chatHistoryParams.safeParse({ principalId: "drk", limit: 100 }).success).toBe(true);
  });

  test.each([
    { principalId: "drk", limit: 0 },
    { principalId: "drk", limit: 101 },
    { principalId: "drk", limit: 1.5 },
    { principalId: "drk", before: long },
    { principalId: "drk", before: 5 },
    { limit: 10 },
  ])("rejects %j", (p) => expect(chatHistoryParams.safeParse(p).success).toBe(false));
});

describe("chat/history result", () => {
  const user = {
    type: "user",
    id: "e1",
    clientId: "01J9ZQ8M3V7B6XKQ2T4R5S6Y7Z",
    at: "2026-09-30T10:00:00.000Z",
    text: "look at this",
    attachments: [{ uploadId: UID, name: "photo.jpg", contentType: "image/jpeg" }],
  };
  const assistant = {
    type: "assistant",
    id: "e2",
    at: "2026-09-30T10:00:05.000Z",
    text: "done",
    outboxId: "o1",
    turnId: "t1",
    tools: [{ name: "bash", summary: "ls", ok: true }],
    usage: { model: "gpt-5", inputTokens: 10, outputTokens: 2 },
  };
  const ask = { type: "ask", id: "e3", at: "2026-09-30T10:01:00.000Z", outboxId: "o2", askId: "a1", question: "Which?", choices: ["A", "B"] };
  const divider = { type: "divider", id: "e4", at: "2026-09-30T10:02:00.000Z", kind: "compacted", summary: "recap" };

  test("accepts every item type and a null cursor", () => {
    const r = chatHistoryResult.parse({ items: [user, assistant, ask, divider], before: null });
    expect(r.items.map((i) => i.type)).toEqual(["user", "assistant", "ask", "divider"]);
  });

  test("accepts a user item with a JSONL-only attachment (no upload id) and no clientId", () => {
    const { clientId: _, ...bare } = user;
    expect(historyItem.safeParse({ ...bare, attachments: [{ name: "old.png", contentType: "image/png" }] }).success).toBe(true);
  });

  test.each([
    ["an unknown type", { ...divider, type: "approval" }],
    ["a bad upload id", { ...user, attachments: [{ uploadId: "../x", name: "a", contentType: "image/png" }] }],
    ["an oversized clientId", { ...user, clientId: long }],
    ["an empty id", { ...assistant, id: "" }],
    ["an oversized outboxId", { ...assistant, outboxId: long }],
    ["an oversized turnId", { ...assistant, turnId: long }],
    ["an oversized askId", { ...ask, askId: long }],
    ["an ask without outboxId", { ...ask, outboxId: undefined }],
    ["an unknown divider kind", { ...divider, kind: "forked" }],
    ["a tool without ok", { ...assistant, tools: [{ name: "bash", summary: "ls" }] }],
  ])("rejects %s", (_, item) => expect(historyItem.safeParse(item).success).toBe(false));

  test("rejects more than 100 items and an oversized cursor", () => {
    expect(chatHistoryResult.safeParse({ items: Array.from({ length: 101 }, (_, i) => ({ ...divider, id: `d${i}` })), before: null }).success).toBe(false);
    expect(chatHistoryResult.safeParse({ items: [], before: long }).success).toBe(false);
    expect(chatHistoryResult.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("upload/read", () => {
  test("method name", () => expect(RPC_METHODS.uploadRead).toBe("upload/read"));

  test("params need a 22-char base64url id", () => {
    expect(uploadReadParams.safeParse({ principalId: "drk", uploadId: UID }).success).toBe(true);
    for (const uploadId of ["", UID.slice(1), `${UID}A`, "AbCdEfGhIjKlMnOpQrSt+/", "../../../../etc/passwd..", `${UID.slice(0, 21)}.`]) {
      expect(uploadReadParams.safeParse({ principalId: "drk", uploadId }).success).toBe(false);
    }
    expect(uploadReadParams.safeParse({ principalId: long, uploadId: UID }).success).toBe(false);
    expect(uploadReadParams.safeParse({ uploadId: UID }).success).toBe(false);
  });

  test("result: ok with padded base64, or an error", () => {
    expect(uploadReadResult.safeParse({ ok: true, name: "p.jpg", contentType: "image/jpeg", dataBase64: "AAAA" }).success).toBe(true);
    expect(uploadReadResult.safeParse({ ok: false, error: "not referenced" }).success).toBe(true);
  });

  test.each([
    ["unpadded base64", { ok: true, name: "p", contentType: "image/png", dataBase64: "AAA" }],
    ["non-base64", { ok: true, name: "p", contentType: "image/png", dataBase64: "AA*A" }],
    ["an empty content type", { ok: true, name: "p", contentType: "", dataBase64: "AAAA" }],
    ["an error without text", { ok: false }],
  ])("rejects %s", (_, r) => expect(uploadReadResult.safeParse(r).success).toBe(false));

  test("rejects bytes over the upload cap", () => {
    const over = "A".repeat(Math.ceil((UPLOAD_MAX_BYTES + 3) / 3) * 4);
    expect(uploadReadResult.safeParse({ ok: true, name: "p", contentType: "image/png", dataBase64: over }).success).toBe(false);
  });
});
