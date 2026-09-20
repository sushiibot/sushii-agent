import {
  RPC_METHODS,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  type RunnerAdapter,
  type RunnerEvent,
} from "../contracts.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("orchestration:client");

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface OrchestrationClientOptions {
  url: string;
  runnerId: string;
  kind: string;
  projects?: string[];
  adapter: RunnerAdapter;
  // Keep-alive interval (default 30s, under Bun.serve's 120s idle default). 0 disables.
  heartbeatMs?: number;
  // Cap for reconnect backoff (default 30s). Only used by run().
  backoffCapMs?: number;
}

// Runner-side WS client. Dials out, registers, then answers inbound
// session/* calls by delegating to the supplied RunnerAdapter and pushing
// its events back as session/update notifications.
export class OrchestrationClient {
  private readonly options: OrchestrationClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingCall>();
  // Guards against a second start() re-subscribing a task whose stream() is already running.
  // Keyed by generation rather than a plain Set: resume() always forces a fresh subscription (its
  // adapter may have killed and respawned the process), and the OLD subscription's own cleanup
  // must not be able to clobber the guard entry a newer subscription already installed.
  private readonly streamingGenerations = new Map<string, number>();
  private nextStreamGeneration = 1;
  private shouldRun = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private resolveClosed: (() => void) | null = null;

  constructor(options: OrchestrationClientOptions) {
    this.options = options;
  }

  // Daemon entry point: connect → register → listen → heartbeat, reconnecting with capped
  // exponential backoff whenever the socket drops. Resolves only when close() is called, so a
  // runner started before the orchestrator is listening simply retries until the port is up.
  async run(): Promise<void> {
    this.shouldRun = true;
    let backoff = 500;
    const cap = this.options.backoffCapMs ?? 30_000;
    while (this.shouldRun) {
      try {
        await this.connect();
        this.listen();
        this.startHeartbeat();
        logger.info({ runnerId: this.options.runnerId }, "runner connected");
        backoff = 500;
        await new Promise<void>((res) => (this.resolveClosed = res));
      } catch (err) {
        logger.warn({ err }, "runner connection attempt failed");
      } finally {
        this.stopHeartbeat();
      }
      if (!this.shouldRun) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, cap);
    }
  }

  private startHeartbeat(): void {
    const ms = this.options.heartbeatMs ?? 30_000;
    if (ms <= 0) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({ jsonrpc: "2.0", method: RPC_METHODS.heartbeat, params: { runnerId: this.options.runnerId } }),
        );
      }
    }, ms);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;

      ws.addEventListener("close", () => {
        this.rejectAllPending(new Error("connection closed"));
        this.ws = null;
        this.resolveClosed?.();
        this.resolveClosed = null;
      });

      ws.addEventListener("open", () => {
        const id = this.nextId++;
        this.pending.set(id, { resolve: () => resolve(), reject });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: RPC_METHODS.register,
            params: {
              runnerId: this.options.runnerId,
              kind: this.options.kind,
              projects: this.options.projects ?? [],
            },
          }),
        );

        const onRegisterAck = (event: MessageEvent) => {
          const parsed = jsonRpcResponse.safeParse(JSON.parse(event.data.toString()));
          if (!parsed.success) return;
          const call = this.pending.get(parsed.data.id);
          if (!call) return;
          this.pending.delete(parsed.data.id);
          ws.removeEventListener("message", onRegisterAck);
          if (parsed.data.error) call.reject(new Error(parsed.data.error.message));
          else call.resolve(undefined);
        };
        ws.addEventListener("message", onRegisterAck);
      });

      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
    });
  }

  // Call once, after connect() resolves, to start answering session/* calls.
  listen(): void {
    const ws = this.ws;
    if (!ws) throw new Error("not connected");
    ws.addEventListener("message", (event) => {
      this.handleMessage(ws, event.data.toString());
    });
  }

  close(): void {
    this.shouldRun = false;
    this.stopHeartbeat();
    this.rejectAllPending(new Error("connection closed"));
    this.resolveClosed?.();
    this.resolveClosed = null;
    this.ws?.close();
    this.ws = null;
  }

  private rejectAllPending(err: Error): void {
    for (const call of this.pending.values()) call.reject(err);
    this.pending.clear();
  }

  // Starts adapter.stream() for a task. `resubscribe: true` (used by resume(), whose adapter may
  // have killed and respawned the process) always starts a fresh subscription even if a previous
  // one is still draining; otherwise a subscription already in flight is left alone.
  private beginStream(ws: WebSocket, taskId: string, opts: { resubscribe?: boolean } = {}): void {
    if (!opts.resubscribe && this.streamingGenerations.has(taskId)) return;
    const generation = this.nextStreamGeneration++;
    this.streamingGenerations.set(taskId, generation);
    this.options.adapter
      .stream(taskId, (e) => this.emit(ws, e))
      .catch((err) => {
        logger.error({ err, taskId }, "runner adapter stream failed");
        this.emit(ws, {
          kind: "status",
          taskId,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        // Only clear the guard if it still points at THIS subscription — a newer one (started by a
        // resume() that raced this cleanup) must not have its guard entry deleted out from under it.
        if (this.streamingGenerations.get(taskId) === generation) {
          this.streamingGenerations.delete(taskId);
        }
      });
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const req = jsonRpcRequest.safeParse(parsed);
    if (!req.success) return;

    const { id, method, params } = req.data;
    const adapter = this.options.adapter;

    try {
      if (method === RPC_METHODS.start) {
        const input = params as { taskId: string; cwd: string; prompt: string };
        const result = await adapter.start(input);
        this.respond(ws, id, result);
        this.beginStream(ws, input.taskId);
      } else if (method === RPC_METHODS.resume) {
        const input = params as { taskId: string; nativeSessionId: string; prompt: string };
        await adapter.resume(input);
        this.respond(ws, id, { ok: true });
        this.beginStream(ws, input.taskId, { resubscribe: true });
      } else if (method === RPC_METHODS.interrupt) {
        const input = params as { taskId: string };
        await adapter.interrupt(input.taskId);
        this.respond(ws, id, { ok: true });
      }
    } catch (err) {
      this.respondError(ws, id, err instanceof Error ? err.message : String(err));
    }
  }

  private respond(ws: WebSocket, id: string | number, result: unknown): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(ws: WebSocket, id: string | number, message: string): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  }

  private emit(ws: WebSocket, event: RunnerEvent): void {
    if (ws.readyState !== ws.OPEN) return;
    const notification = { jsonrpc: "2.0" as const, method: RPC_METHODS.event, params: event };
    const parsed = jsonRpcNotification.safeParse(notification);
    if (!parsed.success) {
      logger.error({ error: parsed.error }, "built an invalid session/update notification");
      return;
    }
    ws.send(JSON.stringify(parsed.data));
  }
}
