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

  // The live (still-running) SSE path forwards hub.onLine/onStatus to writeSSE and closes on settle
  // via an event callback (not a blocking poll). Its subscription mechanics are covered by the
  // ActivityHub tests; a full over-HTTP live assertion needs a real socket (Bun's in-memory
  // app.request doesn't drive an open SSE stream), so it's exercised in the live deploy, not here.

  test("SSE stream delivers backlog + final status for a settled task", async () => {
    const app = appWithRoutes();
    const hub = getActivityHub();
    const token = hub.open("web-sse");
    hub.append("web-sse", "🔧 bash: ls", 1);
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
    hub.append("web-resume", "line-A", 1); // seq 1
    hub.append("web-resume", "line-B", 2); // seq 2
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
});
