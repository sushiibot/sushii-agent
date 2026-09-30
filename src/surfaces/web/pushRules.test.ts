import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { DEFAULT_QUIET_HOURS, QuietHoursStore, isQuietAt, localMinutes, plainPushBody, pushFor, resolveTimeZone } from "./pushRules.ts";

describe("pushFor", () => {
  test("maps each event to its tag, deep link and flags", () => {
    const quiet = false;
    expect(pushFor({ kind: "approval", nonce: "n1", tool: "file_linear_issue" }, { quiet })).toEqual({
      title: "Approval needed",
      body: "sushii-agent needs your approval to run file_linear_issue",
      url: "/?approve=n1",
      tag: "approval:n1",
      requireInteraction: true,
    });
    expect(pushFor({ kind: "ask", askId: "a 1", question: "Which?" }, { quiet })).toEqual({ title: "The agent asks", body: "Which?", url: "/?ask=a%201", tag: "ask:a 1" });
    expect(pushFor({ kind: "auth" }, { quiet })).toMatchObject({ tag: "auth", body: "Sign-in link ready" });
    expect(pushFor({ kind: "reply", text: "done" }, { quiet })).toEqual({ title: "sushii-agent", body: "done", url: "/", tag: "chat", renotify: false });
    expect(pushFor({ kind: "proactive", text: "" }, { quiet })).toMatchObject({ tag: "chat", body: "Sent a file" });
    expect(pushFor({ kind: "interrupted" }, { quiet })).toMatchObject({ tag: "chat", body: "Turn interrupted" });
  });

  test("an ask without an id falls back to the chat tag and still rings", () => {
    const p = pushFor({ kind: "ask", askId: "", question: "q" }, { quiet: true });
    expect(p).toMatchObject({ tag: "chat", url: "/" });
    expect(p.silent).toBeUndefined();
  });

  test("quiet hours silence everything but approvals and asks, and drop nothing", () => {
    const quiet = true;
    expect(pushFor({ kind: "approval", nonce: "n", tool: "t" }, { quiet }).silent).toBeUndefined();
    expect(pushFor({ kind: "ask", askId: "a", question: "q" }, { quiet }).silent).toBeUndefined();
    for (const e of [{ kind: "reply", text: "x" }, { kind: "proactive", text: "x" }, { kind: "auth" }, { kind: "interrupted" }] as const) {
      expect(pushFor(e, { quiet }).silent).toBe(true);
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

describe("quiet hours", () => {
  const NY = "America/New_York";
  const q = (start: string, end: string) => ({ enabled: true, start, end });

  test("a range across midnight, and a disabled range", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(isQuietAt(q("22:00", "07:00"), "UTC", at("2026-06-01T23:30:00Z"))).toBe(true);
    expect(isQuietAt(q("22:00", "07:00"), "UTC", at("2026-06-01T06:59:00Z"))).toBe(true);
    expect(isQuietAt(q("22:00", "07:00"), "UTC", at("2026-06-01T07:00:00Z"))).toBe(false);
    expect(isQuietAt(q("09:00", "17:00"), "UTC", at("2026-06-01T12:00:00Z"))).toBe(true);
    expect(isQuietAt({ ...q("00:00", "00:00"), enabled: false }, "UTC", at("2026-06-01T12:00:00Z"))).toBe(false);
  });

  test("follows the zone's wall clock across the spring-forward gap", () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z).
    expect(localMinutes(NY, Date.parse("2026-03-08T06:59:00Z"))).toBe(1 * 60 + 59);
    expect(localMinutes(NY, Date.parse("2026-03-08T07:00:00Z"))).toBe(3 * 60);
    // Quiet until 02:30, a time that never happens that night: it ends at the jump.
    expect(isQuietAt(q("22:00", "02:30"), NY, Date.parse("2026-03-08T06:59:00Z"))).toBe(true);
    expect(isQuietAt(q("22:00", "02:30"), NY, Date.parse("2026-03-08T07:00:00Z"))).toBe(false);
    // 07:00 local is 11:00Z after the change, not 12:00Z.
    expect(isQuietAt(q("22:00", "07:00"), NY, Date.parse("2026-03-08T10:59:00Z"))).toBe(true);
    expect(isQuietAt(q("22:00", "07:00"), NY, Date.parse("2026-03-08T11:00:00Z"))).toBe(false);
  });

  test("follows the zone's wall clock across the fall-back repeat", () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST (06:00Z); 01:30 happens twice.
    expect(localMinutes(NY, Date.parse("2026-11-01T05:30:00Z"))).toBe(90);
    expect(localMinutes(NY, Date.parse("2026-11-01T06:30:00Z"))).toBe(90);
    expect(isQuietAt(q("22:00", "07:00"), NY, Date.parse("2026-11-01T11:59:00Z"))).toBe(true);
    expect(isQuietAt(q("22:00", "07:00"), NY, Date.parse("2026-11-01T12:00:00Z"))).toBe(false);
  });

  test("midnight formats as 0, not 24", () => {
    expect(localMinutes("UTC", Date.parse("2026-06-01T00:00:00Z"))).toBe(0);
  });

  test("an unknown or empty zone falls back to UTC", () => {
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone(" Europe/Berlin ")).toBe("Europe/Berlin");
  });

  test("the store persists in kv and ignores a corrupt row", () => {
    const db = new Database(":memory:");
    applySchema(db);
    let now = Date.parse("2026-06-01T23:00:00Z");
    const s = new QuietHoursStore(db, "UTC", () => now);
    expect(s.get()).toEqual(DEFAULT_QUIET_HOURS);
    expect(s.isQuiet()).toBe(false);
    s.set(q("22:00", "07:00"));
    expect(new QuietHoursStore(db, "UTC").get()).toEqual(q("22:00", "07:00"));
    expect(s.isQuiet()).toBe(true);
    now = Date.parse("2026-06-01T12:00:00Z");
    expect(s.isQuiet()).toBe(false);
    db.run("UPDATE kv SET value = 'nope' WHERE key = 'web:quiet_hours'");
    expect(s.get()).toEqual(DEFAULT_QUIET_HOURS);
  });
});
