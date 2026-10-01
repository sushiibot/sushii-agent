import {
  ORCH_CLOSE,
  PROTOCOL_VERSION,
  RPC_METHODS,
  jsonRpcRequest,
  jsonRpcResponse,
  type ToolManifestEntry,
  type WorkspaceRegisterResult,
  toolManifestEntry,
  workspaceRegisterResult,
} from "../contracts.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("orchestration:client");

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** request() found no open link; nothing was sent. */
export class NotConnectedError extends Error {
  constructor() {
    super("not connected");
  }
}

/** The link dropped after the request was sent; the peer may or may not have acted on it. */
export class ConnectionClosedError extends Error {
  constructor() {
    super("connection closed");
  }
}

/** No response within the request's timeoutMs; the peer may still act on it. */
export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no response within ${Math.round(timeoutMs / 1000)} s`);
  }
}

/** Thrown by a request handler to answer with this JSON-RPC error code instead of the generic -32000. */
export class RpcHandlerError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** The peer answered a request with a JSON-RPC error. */
export class RpcErrorResponse extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export interface OrchestrationClientOptions {
  url: string;
  runnerId: string;
  kind: string;
  /** ORCH_SECRET; omitted when unset. */
  secret?: string;
  principalId?: string;
  /** A getter reports the live state at each (re)register. */
  state?: "idle" | "streaming" | (() => "idle" | "streaming");
  /** Inbound request methods, answered with the handler's result. */
  handlers?: Record<string, (params: unknown) => Promise<unknown>>;
  /** Fires after each successful (re)register, once responses are routed, with the parsed register
   *  result (a malformed one reads as no tools). */
  onRegistered?: (result: WorkspaceRegisterResult) => void;
  // Keep-alive interval (default 30s, under Bun.serve's 120s idle default). 0 disables.
  heartbeatMs?: number;
  // Cap for reconnect backoff (default 30s). Only used by run().
  backoffCapMs?: number;
}

// Workspace-side WS client. Dials the bot, registers as role "workspace", then answers inbound
// requests with the supplied handlers.
export class OrchestrationClient {
  private readonly options: OrchestrationClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingCall>();
  private shouldRun = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private resolveClosed: (() => void) | null = null;
  private lastCloseCode: number | null = null;
  private socketClosed: Promise<void> = Promise.resolve();

  constructor(options: OrchestrationClientOptions) {
    this.options = options;
  }

  // Daemon entry point: connect → register → listen → heartbeat, reconnecting with capped
  // exponential backoff whenever the socket drops. Resolves only when close() is called, so a
  // workspace started before the bot is listening simply retries until the port is up.
  async run(): Promise<void> {
    this.shouldRun = true;
    let backoff = 500;
    const cap = this.options.backoffCapMs ?? 30_000;
    while (this.shouldRun) {
      this.lastCloseCode = null;
      try {
        const result = await this.connect();
        this.listen();
        this.startHeartbeat();
        logger.info({ runnerId: this.options.runnerId }, "connected to the bot");
        this.options.onRegistered?.(this.registerResult(result));
        backoff = 500;
        await new Promise<void>((res) => (this.resolveClosed = res));
      } catch (err) {
        logger.warn({ err }, "connection attempt to the bot failed");
        // The server sends its rejection before its close frame; wait for the close code so the delay below sees it.
        await this.awaitSocketClosed(2_000);
      } finally {
        this.stopHeartbeat();
      }
      if (!this.shouldRun) break;
      // Two live workspaces (or a runnerId clash) would evict each other on every reconnect; wait the cap.
      const delay = this.lastCloseCode === ORCH_CLOSE.replaced ? cap : backoff;
      await new Promise((r) => setTimeout(r, delay));
      backoff = Math.min(backoff * 2, cap);
    }
  }

  private registerResult(raw: unknown): WorkspaceRegisterResult {
    const parsed = workspaceRegisterResult.safeParse(raw);
    if (parsed.success) return parsed.data;
    // A bad tool list must not also hide the bot's features: alerts would then go out as plain text.
    const rawFeatures = (raw as { features?: unknown } | null)?.features;
    const features = workspaceRegisterResult.shape.features.safeParse(rawFeatures);
    const withFeatures = features.success && features.data ? { features: features.data } : {};
    const listed = (raw as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(listed)) {
      logger.warn({ runnerId: this.options.runnerId, error: parsed.error.issues[0]?.message }, "malformed workspace register result; no tools offered");
      return { ok: true, tools: [], ...withFeatures };
    }
    // One entry this workspace can't read (say, a newer approval kind) drops only that tool.
    const tools: ToolManifestEntry[] = [];
    for (const t of listed) {
      const entry = toolManifestEntry.safeParse(t);
      if (entry.success) tools.push(entry.data);
      else logger.warn({ runnerId: this.options.runnerId, tool: (t as { name?: unknown } | null)?.name, error: entry.error.issues[0]?.message }, "skipping a malformed tool manifest entry");
    }
    return { ok: true, tools, ...withFeatures };
  }

  private async awaitSocketClosed(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs)));
    const timedOutFirst = await Promise.race([this.socketClosed.then(() => false), timedOut]);
    clearTimeout(timer);
    if (timedOutFirst && this.ws) {
      this.ws.close();
      this.ws = null;
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

  /** Resolves with the register call's result. */
  connect(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;
      let markClosed = () => {};
      this.socketClosed = new Promise<void>((r) => (markClosed = r));

      ws.addEventListener("close", (event) => {
        markClosed();
        this.lastCloseCode = event.code;
        if (event.code === ORCH_CLOSE.unauthorized || event.code === ORCH_CLOSE.unsupportedVersion) {
          logger.error(
            { runnerId: this.options.runnerId, code: event.code, reason: event.reason },
            "orchestrator rejected registration; retrying with backoff",
          );
        } else if (event.code === ORCH_CLOSE.replaced) {
          logger.warn({ runnerId: this.options.runnerId, reason: event.reason }, "orchestrator closed the connection as a duplicate");
        }
        this.rejectAllPending(new ConnectionClosedError());
        if (this.ws === ws) this.ws = null;
        this.resolveClosed?.();
        this.resolveClosed = null;
      });

      ws.addEventListener("open", () => {
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: RPC_METHODS.register,
            params: {
              runnerId: this.options.runnerId,
              kind: this.options.kind,
              // Explicit: a bot older than this protocol defaults a missing role to "task-runner".
              role: "workspace",
              protocolVersion: PROTOCOL_VERSION,
              ...(this.options.secret ? { secret: this.options.secret } : {}),
              ...(this.options.principalId ? { principalId: this.options.principalId } : {}),
              ...(this.options.state ? { state: typeof this.options.state === "function" ? this.options.state() : this.options.state } : {}),
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
          else call.resolve(parsed.data.result);
        };
        ws.addEventListener("message", onRegisterAck);
      });

      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
    });
  }

  // Call once, after connect() resolves, to start answering inbound requests.
  listen(): void {
    const ws = this.ws;
    if (!ws) throw new Error("not connected");
    ws.addEventListener("message", (event) => {
      this.handleMessage(ws, event.data.toString());
    });
  }

  /** Sends a request to the orchestrator. Rejects with NotConnectedError (not sent), ConnectionClosedError
   *  (the link dropped before the response) or RequestTimeoutError; never retries. */
  request(method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new NotConnectedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new RequestTimeoutError(opts.timeoutMs!));
        }, opts.timeoutMs);
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Fire-and-forget notification; dropped while disconnected. */
  notify(method: string, params: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === this.ws.OPEN;
  }

  close(): void {
    this.shouldRun = false;
    this.stopHeartbeat();
    this.rejectAllPending(new ConnectionClosedError());
    this.resolveClosed?.();
    this.resolveClosed = null;
    this.ws?.close();
    this.ws = null;
  }

  private rejectAllPending(err: Error): void {
    for (const call of this.pending.values()) call.reject(err);
    this.pending.clear();
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const req = jsonRpcRequest.safeParse(parsed);
    if (!req.success) {
      this.handleResponse(parsed);
      return;
    }

    const { id, method, params } = req.data;
    const handler = this.options.handlers?.[method];

    try {
      if (handler) {
        this.respond(ws, id, await handler(params));
      } else {
        this.respondError(ws, id, `method not found: ${method}`, -32601);
      }
    } catch (err) {
      if (err instanceof RpcHandlerError) this.respondError(ws, id, err.message, err.code);
      else this.respondError(ws, id, err instanceof Error ? err.message : String(err));
    }
  }

  private respond(ws: WebSocket, id: string | number, result: unknown): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(ws: WebSocket, id: string | number, message: string, code = -32000): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private handleResponse(parsed: unknown): void {
    const res = jsonRpcResponse.safeParse(parsed);
    if (!res.success) return;
    const call = this.pending.get(res.data.id);
    if (!call) return;
    this.pending.delete(res.data.id);
    if (res.data.error) call.reject(new RpcErrorResponse(res.data.error.message, res.data.error.code));
    else call.resolve(res.data.result);
  }
}
