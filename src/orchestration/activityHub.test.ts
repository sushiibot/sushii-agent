import { describe, expect, test } from "bun:test";
import { ActivityHub, taskViewUrl } from "./activityHub.ts";

describe("ActivityHub", () => {
  test("buffers lines, fans out to subscribers, and gates by token", () => {
    const hub = new ActivityHub();
    const token = hub.open("t1");
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    hub.append("t1", "first", 1);
    const view = hub.view("t1")!;
    expect(view.lines.map((l) => l.line)).toEqual(["first"]);

    const got: string[] = [];
    const unsub = view.onLine((l) => got.push(l.line));
    hub.append("t1", "second", 2);
    expect(got).toEqual(["second"]);
    unsub();
    hub.append("t1", "third", 3);
    expect(got).toEqual(["second"]); // unsubscribed

    // Token gate: wrong token → no view, right token → view.
    expect(hub.viewWithToken("t1", "deadbeef")).toBeNull();
    expect(hub.viewWithToken("t1", token)).not.toBeNull();
  });

  test("settle notifies status subscribers and records final status/summary", () => {
    const hub = new ActivityHub();
    hub.open("t2");
    const view = hub.view("t2")!;
    let seen: [string, string | null] | null = null;
    view.onStatus((status, summary) => (seen = [status, summary]));
    hub.settle("t2", "done", "all good");
    expect(seen).toEqual(["done", "all good"]);
    expect(hub.view("t2")!.status).toBe("done");
  });

  test("append is a no-op for an unopened task; taskViewUrl needs a base", () => {
    const hub = new ActivityHub();
    hub.append("ghost", "x", 1); // must not throw
    expect(hub.view("ghost")).toBeNull();
    expect(taskViewUrl(undefined, "t", "k")).toBeNull();
    expect(taskViewUrl("https://h.example/", "t", "k")).toBe("https://h.example/tasks/t?key=k");
  });
});
