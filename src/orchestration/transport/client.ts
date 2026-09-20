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
}

// Runner-side WS client. Dials out, registers, then answers inbound
// session/* calls by delegating to the supplied RunnerAdapter and pushing
// its events back as session/update notifications.
export class OrchestrationClient {
  private readonly options: OrchestrationClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingCall>();
  // Guards against resume() re-subscribing a task whose stream() is
  // already running from an earlier start().
  private readonly streamingTasks = new Set<string>();

  constructor(options: OrchestrationClientOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;

      ws.addEventListener("close", () => {
        this.rejectAllPending(new Error("connection closed"));
        this.ws = null;
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
    this.rejectAllPending(new Error("connection closed"));
    this.ws?.close();
    this.ws = null;
  }

  private rejectAllPending(err: Error): void {
    for (const call of this.pending.values()) call.reject(err);
    this.pending.clear();
  }

  // Starts adapter.stream() for a task at most once; resume() must not
  // re-subscribe a stream already running from an earlier start().
  private beginStream(ws: WebSocket, taskId: string): void {
    if (this.streamingTasks.has(taskId)) return;
    this.streamingTasks.add(taskId);
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
        this.streamingTasks.delete(taskId);
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
        this.beginStream(ws, input.taskId);
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
