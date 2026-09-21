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
    expect(await ok.text()).toContain("web-html");
  });

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

  test("SSE stream 404s on a bad token", async () => {
    const app = appWithRoutes();
    getActivityHub().open("web-sse-2");
    expect((await app.request("/tasks/web-sse-2/stream?key=nope")).status).toBe(404);
  });
});
