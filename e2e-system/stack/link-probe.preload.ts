// Bot preload: lets flows send bot → workspace RPCs over the real orchestration link before the bot has
// HTTP routes for them. Captures the bot's OrchestrationServer and serves POST /request on a unix socket
// in the run's temp dir (E2E_LINK_SOCKET), which the runner's control server forwards to. Each result is
// checked against the pinned contract schema in the bot process, where the bot's own parse would run.
import { rmSync } from "node:fs";

const socket = process.env["E2E_LINK_SOCKET"];
if (!socket) throw new Error("E2E_LINK_SOCKET is unset");

// Computed paths, so the harness typecheck does not pull in the bot's whole type graph.
type Server = { requestWorkspace(principalId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> };
type Schema = { safeParse(v: unknown): { success: boolean; error?: { message: string } } };
const server = (await import(new URL("../../src/orchestration/transport/server.ts", import.meta.url).href)) as { OrchestrationServer: { prototype: { listen(...a: unknown[]): unknown } } };
const c = (await import(new URL("../../src/orchestration/contracts.ts", import.meta.url).href)) as Record<string, Schema> & { RPC_METHODS: Record<string, string> };

const results: Record<string, Schema | undefined> = {
  [c.RPC_METHODS["runsList"]!]: c["runsListResult"],
  [c.RPC_METHODS["runsGet"]!]: c["runsGetResult"],
  [c.RPC_METHODS["historyDays"]!]: c["historyDaysResult"],
  [c.RPC_METHODS["historyDay"]!]: c["historyDayResult"],
  [c.RPC_METHODS["historySearch"]!]: c["historySearchResult"],
};

let captured: Server | null = null;
const listen = server.OrchestrationServer.prototype.listen;
server.OrchestrationServer.prototype.listen = function (this: Server, ...args: unknown[]) {
  captured = this;
  return listen.apply(this, args);
};

rmSync(socket, { force: true });
Bun.serve({
  unix: socket,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/request") return new Response("not found", { status: 404 });
    if (!captured) return Response.json({ error: "orchestration server not started" }, { status: 503 });
    const { principalId, method, params, timeoutMs } = (await req.json()) as { principalId: string; method: string; params: unknown; timeoutMs?: number };
    try {
      const result = await captured.requestWorkspace(principalId, method, params, timeoutMs ?? 10_000);
      const parsed = results[method]?.safeParse(result);
      return Response.json({ result, schemaError: parsed && !parsed.success ? parsed.error?.message : null, bytes: Buffer.byteLength(JSON.stringify(result)) });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
});
export {};
