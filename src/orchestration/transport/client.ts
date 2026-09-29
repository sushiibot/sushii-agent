import {
  ORCH_CLOSE,
  PROTOCOL_VERSION,
  RPC_METHODS,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  type ConnectionRole,
  type RepoSpec,
  type RunnerAdapter,
  type RunnerEvent,
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

export interface OrchestrationClientOptions {
  url: string;
  runnerId: string;
  kind: string;
  projects?: string[];
  workspaceRoot?: string | null;
  location?: string | null;
  capabilities?: string[];
  ownerOnly?: boolean;
  /** Default "task-runner". */
  role?: ConnectionRole;
  /** The role's secret (ORCH_SECRET for a workspace, ORCH_RUNNER_SECRET for a task runner); omitted when unset. */
  secret?: string;
  principalId?: string;
  /** A getter reports the live state at each (re)register. */
  state?: "idle" | "streaming" | (() => "idle" | "streaming");
  /** Absent for connections that serve no session/* verbs (e.g. the workspace). */
  adapter?: RunnerAdapter;
  /** Extra inbound request methods, answered with the handler's result. */
  handlers?: Record<string, (params: unknown) => Promise<unknown>>;
  /** Fires after each successful (re)register, once responses are routed. A workspace gets its parsed
   *  register result (a malformed one reads as no tools); a task runner gets null. */
  onRegistered?: (result: WorkspaceRegisterResult | null) => void;
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
  private lastCloseCode: number | null = null;
  private socketClosed: Promise<void> = Promise.resolve();

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
      this.lastCloseCode = null;
      try {
        const result = await this.connect();
        this.listen();
        this.startHeartbeat();
        logger.info({ runnerId: this.options.runnerId }, "runner connected");
        this.options.onRegistered?.(this.registerResult(result));
        backoff = 500;
        await new Promise<void>((res) => (this.resolveClosed = res));
      } catch (err) {
        logger.warn({ err }, "runner connection attempt failed");
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

  private registerResult(raw: unknown): WorkspaceRegisterResult | null {
    if ((this.options.role ?? "task-runner") !== "workspace") return null;
    const parsed = workspaceRegisterResult.safeParse(raw);
    if (parsed.success) return parsed.data;
    const listed = (raw as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(listed)) {
      logger.warn({ runnerId: this.options.runnerId, error: parsed.error.issues[0]?.message }, "malformed workspace register result; no tools offered");
      return { ok: true, tools: [] };
    }
    // One entry this workspace can't read (say, a newer approval kind) drops only that tool.
    const tools: ToolManifestEntry[] = [];
    for (const t of listed) {
      const entry = toolManifestEntry.safeParse(t);
      if (entry.success) tools.push(entry.data);
      else logger.warn({ runnerId: this.options.runnerId, tool: (t as { name?: unknown } | null)?.name, error: entry.error.issues[0]?.message }, "skipping a malformed tool manifest entry");
    }
    return { ok: true, tools };
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
              projects: this.options.projects ?? [],
              workspaceRoot: this.options.workspaceRoot ?? null,
              location: this.options.location ?? null,
              capabilities: this.options.capabilities ?? [],
              ownerOnly: this.options.ownerOnly ?? false,
              role: this.options.role ?? "task-runner",
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

  // Call once, after connect() resolves, to start answering session/* calls.
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

  // Starts adapter.stream() for a task. `resubscribe: true` (used by resume(), whose adapter may
  // have killed and respawned the process) always starts a fresh subscription even if a previous
  // one is still draining; otherwise a subscription already in flight is left alone.
  private beginStream(ws: WebSocket, taskId: string, opts: { resubscribe?: boolean } = {}): void {
    const adapter = this.options.adapter;
    if (!adapter) return;
    if (!opts.resubscribe && this.streamingGenerations.has(taskId)) return;
    const generation = this.nextStreamGeneration++;
    this.streamingGenerations.set(taskId, generation);
    adapter
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
    if (!req.success) {
      this.handleResponse(parsed);
      return;
    }

    const { id, method, params } = req.data;
    const adapter = this.options.adapter;
    const handler = this.options.handlers?.[method];

    try {
      if (handler) {
        this.respond(ws, id, await handler(params));
      } else if (!adapter) {
        this.respondError(ws, id, `method not found: ${method}`, -32601);
      } else if (method === RPC_METHODS.start) {
        const input = params as { taskId: string; cwd: string; prompt: string; repo?: RepoSpec | null };
        const result = await adapter.start(input);
        this.respond(ws, id, result);
        this.beginStream(ws, input.taskId);
      } else if (method === RPC_METHODS.resume) {
        const input = params as { taskId: string; nativeSessionId: string; cwd: string; prompt: string };
        await adapter.resume(input);
        this.respond(ws, id, { ok: true });
        this.beginStream(ws, input.taskId, { resubscribe: true });
      } else if (method === RPC_METHODS.interrupt) {
        const input = params as { taskId: string };
        await adapter.interrupt(input.taskId);
        this.respond(ws, id, { ok: true });
      } else if (method === RPC_METHODS.stop) {
        const input = params as { taskId: string; discard?: boolean };
        await adapter.stop(input);
        this.respond(ws, id, { ok: true });
      } else if (method === RPC_METHODS.message) {
        const input = params as { taskId: string; text: string };
        this.respond(ws, id, await adapter.steer(input));
      } else if (method === RPC_METHODS.followUp) {
        const input = params as { taskId: string; text: string };
        this.respond(ws, id, await adapter.followUp(input));
      } else if (method === RPC_METHODS.browserWatch) {
        const input = params as { taskId: string; watch: boolean };
        this.respond(ws, id, adapter.watchBrowser ? await adapter.watchBrowser(input) : { supported: false });
      } else {
        this.respondError(ws, id, `method not found: ${method}`, -32601);
      }
    } catch (err) {
      this.respondError(ws, id, err instanceof Error ? err.message : String(err));
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
    if (res.data.error) call.reject(new Error(res.data.error.message));
    else call.resolve(res.data.result);
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
