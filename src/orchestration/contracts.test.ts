import { describe, expect, test } from "bun:test";
import {
  chatDeliverParams,
  chatExportParams,
  chatExportResult,
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

describe("chat/export", () => {
  test("method name", () => expect(RPC_METHODS.chatExport).toBe("chat/export"));

  test("params default to a full page from the newest", () => {
    expect(chatExportParams.parse({ principalId: "drk" })).toEqual({ principalId: "drk", limit: 100 });
    expect(chatExportParams.safeParse({ principalId: "drk", before: "2026-09-30T00-00-00_abc:e1f2", limit: 1 }).success).toBe(true);
  });

  test.each([
    { principalId: "drk", limit: 0 },
    { principalId: "drk", limit: 101 },
    { principalId: "drk", before: long },
    { principalId: "drk", before: 5 },
    { limit: 10 },
  ])("rejects params %j", (p) => expect(chatExportParams.safeParse(p).success).toBe(false));

  const user = { id: "s:e1", role: "user", at: "2026-09-30T10:00:00.000Z", text: "hi", clientId: "01J9ZQ8M3V7B6XKQ2T4R5S6Y7Z" };
  const reply = { id: "s:e2", role: "assistant", at: "2026-09-30T10:00:05.000Z", text: "hello", outboxId: "o1" };

  test("accepts owner messages and replies with a null cursor", () => {
    expect(chatExportResult.parse({ items: [user, reply], before: null }).items.map((i) => i.role)).toEqual(["user", "assistant"]);
  });

  test.each([
    ["an unknown role", { ...user, role: "tool" }],
    ["an empty id", { ...user, id: "" }],
    ["an oversized id", { ...user, id: long }],
    ["an oversized clientId", { ...user, clientId: long }],
    ["an oversized outboxId", { ...reply, outboxId: long }],
    ["an oversized time", { ...reply, at: long }],
  ])("rejects %s", (_, item) => expect(chatExportResult.safeParse({ items: [item], before: null }).success).toBe(false));

  test("rejects more than 100 items, an oversized cursor and a missing one", () => {
    expect(chatExportResult.safeParse({ items: Array.from({ length: 101 }, (_, i) => ({ ...user, id: `s:${i}` })), before: null }).success).toBe(false);
    expect(chatExportResult.safeParse({ items: [], before: long }).success).toBe(false);
    expect(chatExportResult.safeParse({ items: [] }).success).toBe(false);
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
