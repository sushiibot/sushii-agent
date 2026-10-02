// E2E-only control of the real scheduler; production polling stays unchanged.
import { rmSync } from "node:fs";

const socket = process.env["E2E_SCHEDULER_SOCKET"];
if (!socket) throw new Error("E2E_SCHEDULER_SOCKET is unset");

// Dynamic import keeps the harness typecheck separate from the workspace type graph.
const mod = await import(new URL("../../src/workspace/scheduler.ts", import.meta.url).href);
type Scheduler = { tick(): Promise<void> };
let captured: Scheduler | null = null;
const start = mod.Scheduler.prototype.start;
mod.Scheduler.prototype.start = function (this: Scheduler) {
  captured = this;
  return start.call(this);
};

rmSync(socket, { force: true });
Bun.serve({
  unix: socket,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/tick") return new Response("not found", { status: 404 });
    if (!captured) return new Response("scheduler not started", { status: 503 });
    await captured.tick();
    return Response.json({ ok: true });
  },
});
export {};
