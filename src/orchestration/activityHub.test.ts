import { describe, expect, test } from "bun:test";
import { ActivityHub, taskViewUrl } from "./activityHub.ts";

describe("ActivityHub", () => {
  test("buffers lines, fans out to subscribers, and gates by token", () => {
    const hub = new ActivityHub();
    const token = hub.open("t1");
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    hub.append("t1", "first", 1, "text");
    const view = hub.view("t1")!;
    expect(view.lines.map((l) => l.line)).toEqual(["first"]);

    const got: string[] = [];
    const unsub = view.onLine((l) => got.push(l.line));
    hub.append("t1", "second", 2, "text");
    expect(got).toEqual(["second"]);
    unsub();
    hub.append("t1", "third", 3, "text");
    expect(got).toEqual(["second"]); // unsubscribed

    // Token gate: wrong token → no view, right token → view.
    expect(hub.viewWithToken("t1", "deadbeef")).toBeNull();
    expect(hub.viewWithToken("t1", token)).not.toBeNull();
  });

  test("settle notifies status subscribers and records final status/summary", () => {
    const hub = new ActivityHub();
    hub.open("t2");
    const view = hub.view("t2")!;
    const seen: Array<[string, string | null]> = [];
    view.onStatus((status, summary) => seen.push([status, summary]));
    hub.settle("t2", "done", "all good");
    expect(seen).toEqual([["done", "all good"]]);
    expect(hub.view("t2")!.status).toBe("done");
  });

  test("append is a no-op for an unopened task; taskViewUrl needs a base", () => {
    const hub = new ActivityHub();
    hub.append("ghost", "x", 1, "text"); // must not throw
    expect(hub.view("ghost")).toBeNull();
    expect(taskViewUrl(undefined, "t", "k")).toBeNull();
    expect(taskViewUrl("https://h.example/", "t", "k")).toBe("https://h.example/tasks/t?key=k");
  });
});

describe("ActivityHub browser view", () => {
  test("first subscriber starts the relay, last one stops it, state merges", () => {
    const hub = new ActivityHub();
    const calls: [string, boolean][] = [];
    hub.setBrowserWatchHandler((taskId, watch) => calls.push([taskId, watch]));
    hub.open("b1");
    const view = hub.view("b1")!;

    const got: unknown[] = [];
    const unsubA = view.onBrowser((u) => got.push(u));
    const unsubB = view.onBrowser(() => {});
    expect(calls).toEqual([["b1", true]]);

    hub.pushBrowser("b1", { connected: true, url: "https://example.com" });
    hub.pushBrowser("b1", { frame: "AAAA", width: 1024, height: 576 });
    expect(got).toHaveLength(2);
    expect(hub.view("b1")!.browser).toMatchObject({ connected: true, url: "https://example.com", frame: "AAAA", width: 1024 });

    unsubA();
    expect(calls).toHaveLength(1);
    unsubB();
    expect(calls).toEqual([["b1", true], ["b1", false]]);
  });
});
