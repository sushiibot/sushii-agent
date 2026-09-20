import {
  RPC_METHODS,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  type RunnerAdapter,
  type RunnerEvent,
} from "../contracts.ts";

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

  constructor(options: OrchestrationClientOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        const id = this.nextId++;
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
          if (!parsed.success || parsed.data.id !== id) return;
          ws.removeEventListener("message", onRegisterAck);
          if (parsed.data.error) reject(new Error(parsed.data.error.message));
          else resolve();
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
    this.ws?.close();
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
        void adapter.stream(input.taskId, (e) => this.emit(ws, e));
      } else if (method === RPC_METHODS.resume) {
        const input = params as { taskId: string; nativeSessionId: string; prompt: string };
        await adapter.resume(input);
        this.respond(ws, id, { ok: true });
        void adapter.stream(input.taskId, (e) => this.emit(ws, e));
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
    const notification = { jsonrpc: "2.0" as const, method: RPC_METHODS.event, params: event };
    jsonRpcNotification.parse(notification);
    ws.send(JSON.stringify(notification));
  }
}
