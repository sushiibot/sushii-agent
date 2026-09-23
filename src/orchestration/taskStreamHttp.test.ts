import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { getActivityHub } from "./activityHub.ts";
import { registerTaskStreamRoutes } from "./taskStreamHttp.ts";

function appWithRoutes(): Hono {
  const app = new Hono();
  registerTaskStreamRoutes(app);
  return app;
}

describe("task stream routes", () => {
  test("HTML viewer requires the correct token", async () => {
    const app = appWithRoutes();
    const token = getActivityHub().open("web-html");

    expect((await app.request("/tasks/web-html")).status).toBe(404);
    expect((await app.request("/tasks/web-html?key=wrong")).status).toBe(404);
    const ok = await app.request(`/tasks/web-html?key=${token}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("web-html");
    expect(html).not.toContain("__TASK_ID__"); // every placeholder substituted (replaceAll)
  });

  test("served page inlines the markdown libs and every inline script parses", async () => {
    // Guards two regressions the mock harness masked: (1) a template-literal escaping bug that
    // corrupted the client regexes, (2) injecting the marked/DOMPurify source through String.replace
    // where its $&/</script>/</body> sequences mangle the output. Parsing each <script> catches both.
    const app = appWithRoutes();
    const token = getActivityHub().open("web-parse");
    const html = await (await app.request(`/tasks/web-parse?key=${token}`)).text();

    // The libs must be present intact (marked global + DOMPurify sanitize surface).
    expect(html).toContain("DOMPurify");
    expect(html).toMatch(/marked/);

    // Every inline <script> body must be syntactically valid JS. new Function compiles without
    // executing, so a corrupted regex literal or unterminated string throws here.
    const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(bodies.length).toBeGreaterThanOrEqual(2); // inlined libs + the viewer script
    for (const body of bodies) {
      expect(() => new Function(body)).not.toThrow();
    }
  });

  // The live (still-running) SSE path forwards hub.onLine/onStatus to writeSSE and closes on settle
  // via an event callback (not a blocking poll). Its subscription mechanics are covered by the
  // ActivityHub tests; a full over-HTTP live assertion needs a real socket (Bun's in-memory
  // app.request doesn't drive an open SSE stream), so it's exercised in the live deploy, not here.

  test("SSE stream delivers backlog + final status for a settled task", async () => {
    const app = appWithRoutes();
    const hub = getActivityHub();
    const token = hub.open("web-sse");
    hub.append("web-sse", "bash: ls", 1, "tool");
    hub.settle("web-sse", "done", "finished");

    const res = await app.request(`/tasks/web-sse/stream?key=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("bash: ls");
    expect(body).toContain("done");
  });

  test("SSE resume via Last-Event-ID skips already-delivered backlog (no duplication on reconnect)", async () => {
    const app = appWithRoutes();
    const hub = getActivityHub();
    const token = hub.open("web-resume");
    hub.append("web-resume", "line-A", 1, "text"); // seq 1
    hub.append("web-resume", "line-B", 2, "text"); // seq 2
    hub.settle("web-resume", "done", null);

    const res = await app.request(`/tasks/web-resume/stream?key=${token}`, { headers: { "Last-Event-ID": "1" } });
    const body = await res.text();
    expect(body).not.toContain("line-A"); // already seen → not re-sent
    expect(body).toContain("line-B");
  });

  test("SSE stream 404s on a bad token", async () => {
    const app = appWithRoutes();
    getActivityHub().open("web-sse-2");
    expect((await app.request("/tasks/web-sse-2/stream?key=nope")).status).toBe(404);
  });

  test("browser stream is token-gated and sends current state, then updates", async () => {
    const app = appWithRoutes();
    const hub = getActivityHub();
    const token = hub.open("web-browser");
    hub.pushBrowser("web-browser", { connected: true, url: "https://example.com/" });

    expect((await app.request("/tasks/web-browser/browser?key=wrong")).status).toBe(404);
    const res = await app.request(`/tasks/web-browser/browser?key=${token}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil("event: state");
    expect(text).toContain("https://example.com/");
    await new Promise((r) => setTimeout(r, 20)); // the route subscribes after writing the snapshot
    hub.pushBrowser("web-browser", { frame: "QUJD" });
    await readUntil("QUJD");
    expect(text).toContain("event: update");
    hub.settle("web-browser", "idle", null);
    await readUntil("event: end");
    await reader.cancel();
  });

  test("a task settling while watched still delivers its final status", async () => {
    const app = appWithRoutes();
    const hub = getActivityHub();
    const token = hub.open("web-live-settle");
    const res = await app.request(`/tasks/web-live-settle/stream?key=${token}`);
    setTimeout(() => hub.settle("web-live-settle", "done", "all good"), 50);
    const body = await res.text();
    expect(body).toContain("event: status");
    expect(body).toContain("all good");
  });
});
