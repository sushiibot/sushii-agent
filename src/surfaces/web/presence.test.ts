import { describe, expect, test } from "bun:test";
import { createPresence } from "./presence.ts";

describe("presence", () => {
  test("with no stream open, a push goes out at once", async () => {
    const p = createPresence({ head: () => 10, waitMs: 1_000 });
    expect(await p.shouldPush(5)).toBe(true);
  });

  test("a seen receipt within the wait suppresses the push; an open stream alone does not", async () => {
    const p = createPresence({ head: () => 10, waitMs: 20 });
    const close = p.open("s1");
    const suppressed = p.shouldPush(5);
    p.seen(5);
    expect(await suppressed).toBe(false);
    expect(await p.shouldPush(6)).toBe(true);
    close();
  });

  test("a receipt past head is clamped, so it can't mute later events", async () => {
    let head = 3;
    const p = createPresence({ head: () => head, waitMs: 10 });
    const close = p.open("s1");
    p.seen(1_000_000);
    head = 4;
    expect(await p.shouldPush(4)).toBe(true);
    expect(await p.shouldPush(3)).toBe(false);
    close();
  });
});
