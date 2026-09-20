import type { Server, ServerWebSocket } from "bun";
import {
  RPC_METHODS,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  registerParams,
  type RunnerEvent,
} from "../contracts.ts";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface SocketState {
  runnerId: string | null;
  pending: Map<string | number, PendingCall>;
}

export interface OrchestrationServerOptions {
  port?: number;
  onEvent: (runnerId: string, event: RunnerEvent) => void;
  onRegister?: (runnerId: string, kind: string, projects: string[]) => void;
}

// Orchestrator-side WS server. One connection per runner; requests are
// correlated by JSON-RPC id, tracked per-socket in `pending`.
export class OrchestrationServer {
  private readonly options: OrchestrationServerOptions;
  private readonly sockets = new Map<string, ServerWebSocket<SocketState>>();
  private server: Server<SocketState> | null = null;
  private nextId = 1;

  constructor(options: OrchestrationServerOptions) {
    this.options = options;
  }

  listen(): Server<SocketState> {
    this.server = Bun.serve<SocketState>({
      port: this.options.port ?? 0,
      fetch: (req, server) => {
        const success = server.upgrade(req, {
          data: { runnerId: null, pending: new Map() },
        });
        if (success) return undefined;
        return new Response("Upgrade required", { status: 426 });
      },
      websocket: {
        open: () => {},
        close: (ws) => {
          if (ws.data.runnerId) this.sockets.delete(ws.data.runnerId);
        },
        message: (ws, raw) => {
          this.handleMessage(ws, raw);
        },
      },
    });
    return this.server;
  }

  stop(): void {
    this.server?.stop(true);
  }

  get url(): string {
    if (!this.server) throw new Error("server not listening");
    return `ws://localhost:${this.server.port}`;
  }

  private handleMessage(ws: ServerWebSocket<SocketState>, raw: string | Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const notif = jsonRpcNotification.safeParse(parsed);
    if (notif.success && notif.data.method === RPC_METHODS.event) {
      if (ws.data.runnerId) {
        this.options.onEvent(ws.data.runnerId, notif.data.params as RunnerEvent);
      }
      return;
    }

    const req = jsonRpcRequest.safeParse(parsed);
    if (req.success && req.data.method === RPC_METHODS.register) {
      const params = registerParams.parse(req.data.params);
      ws.data.runnerId = params.runnerId;
      this.sockets.set(params.runnerId, ws);
      this.options.onRegister?.(params.runnerId, params.kind, params.projects);
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: req.data.id, result: { ok: true } }),
      );
      return;
    }

    const res = jsonRpcResponse.safeParse(parsed);
    if (res.success) {
      const pending = ws.data.pending.get(res.data.id);
      if (!pending) return;
      ws.data.pending.delete(res.data.id);
      if (res.data.error) pending.reject(new Error(res.data.error.message));
      else pending.resolve(res.data.result);
    }
  }

  private call(runnerId: string, method: string, params: unknown): Promise<unknown> {
    const ws = this.sockets.get(runnerId);
    if (!ws) return Promise.reject(new Error(`runner not connected: ${runnerId}`));

    const id = this.nextId++;
    const request = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise((resolve, reject) => {
      ws.data.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(request));
    });
  }

  start(runnerId: string, input: { taskId: string; cwd: string; prompt: string }): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.start, input);
  }

  resume(
    runnerId: string,
    input: { taskId: string; nativeSessionId: string; prompt: string },
  ): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.resume, input);
  }

  interrupt(runnerId: string, taskId: string): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.interrupt, { taskId });
  }

  isConnected(runnerId: string): boolean {
    return this.sockets.has(runnerId);
  }
}
