import { describe, expect, test } from "bun:test";
import { plainPushBody, pushFor } from "./pushRules.ts";

describe("pushFor", () => {
  test("maps each event to its tag, deep link and flags", () => {
    expect(pushFor({ kind: "approval", nonce: "n1", tool: "file_linear_issue" })).toEqual({
      title: "Approval needed",
      body: "sushii-agent needs your approval to run file_linear_issue",
      url: "/?approve=n1",
      tag: "approval:n1",
      requireInteraction: true,
    });
    expect(pushFor({ kind: "ask", askId: "a 1", question: "Which?" })).toEqual({ title: "The agent asks", body: "Which?", url: "/?ask=a%201", tag: "ask:a 1" });
    expect(pushFor({ kind: "auth" })).toMatchObject({ tag: "auth", body: "Sign-in link ready" });
    expect(pushFor({ kind: "reply", text: "done" })).toEqual({ title: "sushii-agent", body: "done", url: "/", tag: "chat", renotify: false });
    expect(pushFor({ kind: "proactive", text: "" })).toMatchObject({ tag: "chat", body: "Sent a file" });
    expect(pushFor({ kind: "interrupted" })).toMatchObject({ tag: "chat", body: "Turn interrupted" });
    expect(pushFor({ kind: "quota", usedBytes: 4, capBytes: 5 })).toEqual({ title: "Photo storage almost full", body: "80% of the photo quota is used.", url: "/", tag: "quota" });
  });

  test("an ask without an id falls back to the chat tag and still rings", () => {
    const p = pushFor({ kind: "ask", askId: "", question: "q" });
    expect(p).toMatchObject({ tag: "chat", url: "/" });
    expect(p.silent).toBeUndefined();
  });

  test("no push goes out silent", () => {
    for (const e of [{ kind: "approval", nonce: "n", tool: "t" }, { kind: "ask", askId: "a", question: "q" }, { kind: "reply", text: "x" }, { kind: "proactive", text: "x" }, { kind: "auth" }, { kind: "interrupted" }, { kind: "quota", usedBytes: 1, capBytes: 1 }] as const) {
      expect(pushFor(e).silent).toBeUndefined();
    }
  });
});

describe("plainPushBody", () => {
  test("strips markdown to plain text", () => {
    expect(plainPushBody("# Done\n\n**Bold** and _it_ with `code` and [a link](https://x.y)\n- item\n> quote")).toBe("Done Bold and it with code and a link item quote");
    expect(plainPushBody("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(plainPushBody("snake_case_name stays")).toBe("snake_case_name stays");
  });

  test("cuts to 140 code points without splitting a surrogate pair", () => {
    const out = plainPushBody("😀".repeat(200));
    expect(Array.from(out)).toHaveLength(140);
    expect(out.endsWith("😀…")).toBe(true);
    expect(plainPushBody("a".repeat(140))).toBe("a".repeat(140));
  });
});
