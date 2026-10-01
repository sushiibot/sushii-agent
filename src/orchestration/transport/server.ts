import type { Server, ServerWebSocket } from "bun";
import crypto from "node:crypto";
import { ZodError } from "zod";
import {
  ORCH_CLOSE,
  RPC_METHODS,
  SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  registerParams,
  type ConnectionRole,
  type RegisterParams,
  type ToolManifestEntry,
  type WorkspaceRegisterResult,
} from "../contracts.ts";
import { config } from "../../config.ts";
import { ownerPrincipalId } from "../principals.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("orchestration:server");

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Receives traffic from workspace connections. */
export interface WorkspaceHandler {
  onRegister?(conn: ConnectionInfo): void;
  /** Fires only when the closing socket was still the principal's live workspace, not on a replace. */
  onDisconnect?(conn: ConnectionInfo): void;
  /** Fires for every closed workspace socket, a replaced one included, with that socket's own conn. */
  onSocketClosed?(conn: ConnectionInfo): void;
  /** Tools advertised in the workspace's register result. */
  toolManifest?(conn: ConnectionInfo): ToolManifestEntry[];
  /** Delivery kinds beyond the base set this bot accepts, advertised in the register result. */
  features?(conn: ConnectionInfo): string[];
  /** Returns the result; throwing answers with a JSON-RPC error. Unknown methods throw MethodNotFoundError. */
  onRequest?(conn: ConnectionInfo, method: string, params: unknown): Promise<unknown>;
  onNotification?(conn: ConnectionInfo, method: string, params: unknown): void;
}

export class MethodNotFoundError extends Error {}

/** The peer answered with a JSON-RPC error: the request was received and refused. */
export class RpcErrorReply extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}
/** No reply in time; the peer may still have accepted the request. */
export class RpcTimeoutError extends Error {}
/** The socket closed before a reply; the peer may have accepted the request. */
export class RpcConnectionClosedError extends Error {}
export class WorkspaceNotConnectedError extends Error {}

/** True when a failed request may still have been accepted by the peer. */
export function mayHaveBeenAccepted(err: unknown): boolean {
  return err instanceof RpcTimeoutError || err instanceof RpcConnectionClosedError;
}

interface SocketState {
  runnerId: string | null;
  pending: Map<string | number, PendingCall>;
  conn: ConnectionInfo | null;
}

export interface ConnectionInfo {
  runnerId: string;
  role: ConnectionRole;
  principalId: string;
  protocolVersion: number;
  state: "idle" | "streaming" | undefined;
}

/** Principal a valid secret maps to when principals.json declares no owner. */
export const DEFAULT_OWNER_PRINCIPAL_ID = "drk";

export function resolveOwnerPrincipalId(): string {
  return ownerPrincipalId() ?? DEFAULT_OWNER_PRINCIPAL_ID;
}

/** What a secret authorizes: the principal the workspace acts as. */
export interface SecretGrant {
  principalId: string;
}

/** secret → grant, built from config: ORCH_SECRET registers the owner's workspace. */
export function defaultSecretGrants(): Record<string, SecretGrant> {
  return config.orchSecret ? { [config.orchSecret]: { principalId: resolveOwnerPrincipalId() } } : {};
}

/** Looks a presented secret up against every configured one without short-circuiting, so timing
 *  doesn't reveal which (or how much of a) secret matched. */
export function grantForSecret(secrets: Record<string, SecretGrant>, secret: string): SecretGrant | null {
  const presented = Buffer.from(secret);
  let match: SecretGrant | null = null;
  for (const [known, grant] of Object.entries(secrets)) {
    const expected = Buffer.from(known);
    if (expected.length !== presented.length) continue;
    if (crypto.timingSafeEqual(expected, presented)) match = grant;
  }
  return match;
}

export interface OrchestrationServerOptions {
  port?: number;
  /** secret → grant for register auth. Defaults to defaultSecretGrants(); with none, every register is refused. */
  secretGrants?: Record<string, SecretGrant>;
}

// Bot-side WS server that workspaces dial into. Requests are correlated by JSON-RPC id, tracked
// per-socket in `pending`.
export class OrchestrationServer {
  private readonly options: OrchestrationServerOptions;
  private readonly sockets = new Map<string, ServerWebSocket<SocketState>>();
  // principalId → its single live workspace connection.
  private readonly workspaces = new Map<string, ServerWebSocket<SocketState>>();
  private readonly secretGrants: Record<string, SecretGrant>;
  private workspaceHandler: WorkspaceHandler | null = null;
  private server: Server<SocketState> | null = null;
  private nextId = 1;

  constructor(options: OrchestrationServerOptions) {
    this.options = options;
    this.secretGrants = options.secretGrants ?? defaultSecretGrants();
  }

  listen(): Server<SocketState> {
    this.server = Bun.serve<SocketState>({
      port: this.options.port ?? 0,
      fetch: (req, server) => {
        const success = server.upgrade(req, {
          data: { runnerId: null, pending: new Map(), conn: null },
        });
        if (success) return undefined;
        return new Response("Upgrade required", { status: 426 });
      },
      websocket: {
        open: () => {},
        close: (ws) => {
          this.cleanupSocket(ws);
        },
        message: (ws, raw) => {
          this.handleMessage(ws, raw);
        },
      },
    });
    return this.server;
  }

  private cleanupSocket(ws: ServerWebSocket<SocketState>): void {
    const conn = ws.data.conn;
    if (conn && this.workspaces.get(conn.principalId) === ws) {
      this.workspaces.delete(conn.principalId);
      try {
        this.workspaceHandler?.onDisconnect?.(conn);
      } catch (err) {
        logger.warn({ err, runnerId: conn.runnerId }, "workspace disconnect hook failed");
      }
    }
    if (conn) {
      try {
        this.workspaceHandler?.onSocketClosed?.(conn);
      } catch (err) {
        logger.warn({ err, runnerId: conn.runnerId }, "workspace socket-closed hook failed");
      }
    }
    if (ws.data.runnerId && this.sockets.get(ws.data.runnerId) === ws) this.sockets.delete(ws.data.runnerId);
    const closedErr = new RpcConnectionClosedError("connection closed");
    for (const pending of ws.data.pending.values()) pending.reject(closedErr);
    ws.data.pending.clear();
  }

  /** Install before listen() so a workspace that registers at boot gets the register hook. */
  setWorkspaceHandler(handler: WorkspaceHandler | null): void {
    this.workspaceHandler = handler;
  }

  stop(): void {
    this.server?.stop(true);
    this.sockets.clear();
    this.workspaces.clear();
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

    try {
      this.dispatch(ws, parsed);
    } catch (err) {
      const id = (parsed as { id?: string | number })?.id;
      if (id !== undefined) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        );
      }
      logger.warn({ err }, "failed to handle orchestration message");
    }
  }

  private dispatch(ws: ServerWebSocket<SocketState>, parsed: unknown): void {
    const conn = ws.data.conn;
    if (conn && this.dispatchWorkspace(ws, conn, parsed)) return;
    const req = jsonRpcRequest.safeParse(parsed);
    if (req.success && req.data.method === RPC_METHODS.register) {
      const paramsResult = registerParams.safeParse(req.data.params);
      if (!paramsResult.success) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.data.id,
            error: { code: -32602, message: "invalid register params" },
          }),
        );
        ws.close(1008, "invalid register params");
        return;
      }
      if (ws.data.conn) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.data.id, error: { code: -32600, message: "already registered" } }));
        return;
      }
      const params = paramsResult.data;
      // Authenticate before touching any existing connection, so a rejected register can't evict a live workspace.
      const auth = this.authenticate(params);
      if (!auth.ok) {
        logger.warn({ runnerId: params.runnerId, protocolVersion: params.protocolVersion, reason: auth.reason }, "rejected workspace registration");
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.data.id, error: { code: -32001, message: auth.reason } }));
        ws.close(auth.code, auth.reason);
        return;
      }
      const conn: ConnectionInfo = {
        runnerId: params.runnerId,
        role: params.role,
        principalId: auth.principalId,
        protocolVersion: params.protocolVersion,
        state: params.state,
      };
      const existing = this.sockets.get(params.runnerId);
      const existingConn = existing?.data.conn;
      if (existing && existingConn && existingConn.principalId !== conn.principalId) {
        const reason = "runnerId in use by another principal";
        logger.warn({ runnerId: params.runnerId }, reason);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.data.id, error: { code: -32001, message: reason } }));
        ws.close(ORCH_CLOSE.replaced, reason);
        return;
      }
      // Point the principal at the new socket before closing the old one, so the old socket's close
      // (which can run synchronously) isn't reported as the workspace disconnecting.
      const previous = this.workspaces.get(conn.principalId);
      this.workspaces.set(conn.principalId, ws);
      if (existing && existing !== ws) {
        existing.data.runnerId = null;
        existing.close(ORCH_CLOSE.replaced, "replaced by a newer workspace connection");
      }
      if (previous && previous !== ws && previous !== existing) {
        logger.info({ principalId: conn.principalId, runnerId: conn.runnerId }, "replacing previous workspace connection");
        previous.close(ORCH_CLOSE.replaced, "replaced by a newer workspace connection");
      }
      ws.data.runnerId = params.runnerId;
      ws.data.conn = conn;
      this.sockets.set(params.runnerId, ws);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.data.id, result: this.workspaceRegisterResult(conn) }));
      try {
        this.workspaceHandler?.onRegister?.(conn);
      } catch (err) {
        logger.warn({ err, runnerId: conn.runnerId }, "workspace register hook failed");
      }
      return;
    }

    const res = jsonRpcResponse.safeParse(parsed);
    if (res.success) {
      const pending = ws.data.pending.get(res.data.id);
      if (!pending) return;
      ws.data.pending.delete(res.data.id);
      if (res.data.error) pending.reject(new RpcErrorReply(res.data.error.message, res.data.error.code));
      else pending.resolve(res.data.result);
    }
  }

  private workspaceRegisterResult(conn: ConnectionInfo): WorkspaceRegisterResult {
    const features = this.workspaceHandler?.features?.(conn) ?? [];
    const withFeatures = features.length ? { features } : {};
    try {
      return { ok: true, tools: this.workspaceHandler?.toolManifest?.(conn) ?? [], ...withFeatures };
    } catch (err) {
      logger.warn({ err, runnerId: conn.runnerId }, "workspace tool manifest failed; registering with no tools");
      return { ok: true, tools: [], ...withFeatures };
    }
  }

  /** Routes a registered workspace's requests and notifications. False = not handled here (a response). */
  private dispatchWorkspace(ws: ServerWebSocket<SocketState>, conn: ConnectionInfo, parsed: unknown): boolean {
    // A request also parses as a notification (zod strips `id`), so check requests first.
    const req = jsonRpcRequest.safeParse(parsed);
    if (req.success && req.data.method === RPC_METHODS.register) return false;
    if (req.success) {
      const { id, method, params } = req.data;
      const onRequest = this.workspaceHandler?.onRequest;
      const reply = (body: { result: unknown } | { error: { code: number; message: string } }) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
      };
      if (!onRequest) {
        reply({ error: { code: -32601, message: `method not found: ${method}` } });
        return true;
      }
      onRequest(conn, method, params).then(
        (result) => reply({ result: result ?? {} }),
        (err) => {
          const notFound = err instanceof MethodNotFoundError;
          if (!notFound) logger.warn({ err, method, runnerId: conn.runnerId }, "workspace request failed");
          // -32602: the params failed the contract, so the same request will always be refused.
          const code = notFound ? -32601 : err instanceof ZodError ? -32602 : -32000;
          reply({ error: { code, message: err instanceof Error ? err.message : String(err) } });
        },
      );
      return true;
    }
    const notif = jsonRpcNotification.safeParse(parsed);
    if (notif.success) {
      if (notif.data.method === RPC_METHODS.heartbeat) return true;
      try {
        this.workspaceHandler?.onNotification?.(conn, notif.data.method, notif.data.params);
      } catch (err) {
        logger.warn({ err, method: notif.data.method, runnerId: conn.runnerId }, "workspace notification handler failed");
      }
      return true;
    }
    return false;
  }

  private authenticate(params: RegisterParams): { ok: true; principalId: string } | { ok: false; code: number; reason: string } {
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)) {
      return { ok: false, code: ORCH_CLOSE.unsupportedVersion, reason: "unsupported protocolVersion" };
    }
    const unauthorized = { ok: false as const, code: ORCH_CLOSE.unauthorized, reason: "unauthorized" };
    const grant = params.secret === undefined ? null : grantForSecret(this.secretGrants, params.secret);
    if (!grant) return unauthorized;
    if (params.principalId !== undefined && params.principalId !== grant.principalId) return unauthorized;
    return { ok: true, principalId: grant.principalId };
  }

  private callSocket(ws: ServerWebSocket<SocketState>, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const request = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        if (timer) clearTimeout(timer);
        fn(v);
      };
      ws.data.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          ws.data.pending.delete(id);
          reject(new RpcTimeoutError(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      ws.send(JSON.stringify(request));
    });
  }

  /** Sends a request to the principal's live workspace. Rejects when none is connected, on an error
   *  reply, when the socket closes, or after `timeoutMs`. */
  requestWorkspace(principalId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const ws = this.workspaces.get(principalId);
    if (!ws) return Promise.reject(new WorkspaceNotConnectedError(`workspace not connected: ${principalId}`));
    return this.callSocket(ws, method, params, timeoutMs);
  }

  /** The principal's live workspace connection, if one is registered. */
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return this.workspaces.get(principalId)?.data.conn ?? undefined;
  }
}
