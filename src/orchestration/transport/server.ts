import type { Server, ServerWebSocket } from "bun";
import crypto from "node:crypto";
import { z } from "zod";
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
  type RepoSpec,
  type RunnerEvent,
} from "../contracts.ts";
import { config } from "../../config.ts";
import { ownerPrincipalId } from "../principals.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("orchestration:server");

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface SocketState {
  runnerId: string | null;
  pending: Map<string | number, PendingCall>;
  conn: ConnectionInfo | null;
}

export interface ConnectionInfo {
  runnerId: string;
  role: ConnectionRole;
  /** null only for a task runner registered without a secret (no ORCH_RUNNER_SECRET configured). */
  principalId: string | null;
  protocolVersion: number;
  state: "idle" | "streaming" | undefined;
}

/** Principal a valid secret maps to when principals.json declares no owner. */
export const DEFAULT_OWNER_PRINCIPAL_ID = "drk";

/** What a secret authorizes: the principal it acts as, and the roles it may register as. */
export interface SecretGrant {
  principalId: string;
  roles: ConnectionRole[];
}

/** secret → grant, built from config: ORCH_SECRET registers workspaces only, ORCH_RUNNER_SECRET
 *  task runners only, so a task agent that reads its runner's secret can't pose as the workspace. */
export function defaultSecretGrants(): Record<string, SecretGrant> {
  const principalId = ownerPrincipalId() ?? DEFAULT_OWNER_PRINCIPAL_ID;
  const grants: Record<string, SecretGrant> = {};
  if (orchSecretsCollide()) return grants;
  if (config.orchSecret) grants[config.orchSecret] = { principalId, roles: ["workspace"] };
  if (config.orchRunnerSecret) grants[config.orchRunnerSecret] = { principalId, roles: ["task-runner"] };
  return grants;
}

/** True when ORCH_SECRET and ORCH_RUNNER_SECRET share a value: the server then refuses every
 *  register, since a shared value would let any task runner (or its agent) pose as the workspace. */
export function orchSecretsCollide(): boolean {
  return !!config.orchSecret && config.orchSecret === config.orchRunnerSecret;
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

// Local wire-level validator for RunnerEvent — contracts.ts stays a plain
// type, not a schema, so session/update payloads get checked here.
const runnerEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    taskId: z.string(),
    status: z.enum(["running", "idle", "needs_input", "done", "failed"]),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("progress"),
    taskId: z.string(),
    note: z.string(),
  }),
  z.object({
    kind: z.literal("activity"),
    taskId: z.string(),
    line: z.string(),
    at: z.number(),
    atype: z.enum(["tool", "result", "text"]),
  }),
  z.object({
    kind: z.literal("ask"),
    taskId: z.string(),
    askId: z.string(),
    question: z.string(),
    choices: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("owner_message"),
    taskId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("browser"),
    taskId: z.string(),
    supported: z.boolean().optional(),
    connected: z.boolean().optional(),
    frame: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("handback"),
    taskId: z.string(),
    summary: z.string(),
    meta: z
      .object({
        filesChanged: z.number().optional(),
        commits: z.number().optional(),
        testsPassed: z.boolean().optional(),
        toolsRun: z.number().optional(),
        tokens: z.number().optional(),
        costUsd: z.number().optional(),
        durationMs: z.number().optional(),
      })
      .optional(),
  }),
]);

export interface OrchestrationServerOptions {
  port?: number;
  onEvent: (runnerId: string, event: RunnerEvent) => void;
  onRegister?: (
    runnerId: string,
    kind: string,
    projects: string[],
    workspaceRoot: string | null,
    location: string | null,
    capabilities: string[],
    ownerOnly?: boolean,
  ) => void;
  onDisconnect?: (runnerId: string) => void;
  /** secret → grant for register auth. Defaults to defaultSecretGrants(). A role no grant covers
   *  is unsecured: task runners then register without a secret, workspaces never do. */
  secretGrants?: Record<string, SecretGrant>;
}

// Orchestrator-side WS server. One connection per runner; requests are
// correlated by JSON-RPC id, tracked per-socket in `pending`.
export class OrchestrationServer {
  private readonly options: OrchestrationServerOptions;
  private readonly sockets = new Map<string, ServerWebSocket<SocketState>>();
  // principalId → its single live workspace connection.
  private readonly workspaces = new Map<string, ServerWebSocket<SocketState>>();
  private readonly secretGrants: Record<string, SecretGrant>;
  private readonly refuseAllRegisters: boolean;
  private warnedUnauthenticated = false;
  private server: Server<SocketState> | null = null;
  private nextId = 1;

  constructor(options: OrchestrationServerOptions) {
    this.options = options;
    this.secretGrants = options.secretGrants ?? defaultSecretGrants();
    this.refuseAllRegisters = !options.secretGrants && orchSecretsCollide();
    if (this.refuseAllRegisters) {
      logger.error("ORCH_SECRET equals ORCH_RUNNER_SECRET; refusing every runner/register until they differ");
    }
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
    if (conn?.role === "workspace" && conn.principalId && this.workspaces.get(conn.principalId) === ws) {
      this.workspaces.delete(conn.principalId);
    }
    if (ws.data.runnerId && this.sockets.get(ws.data.runnerId) === ws) {
      this.sockets.delete(ws.data.runnerId);
      if (conn?.role !== "workspace") this.options.onDisconnect?.(ws.data.runnerId);
    }
    const closedErr = new Error("connection closed");
    for (const pending of ws.data.pending.values()) pending.reject(closedErr);
    ws.data.pending.clear();
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
    const notif = jsonRpcNotification.safeParse(parsed);
    if (notif.success && notif.data.method === RPC_METHODS.event) {
      // Only task runners feed the dispatcher; a workspace must never touch task state.
      if (conn?.role === "task-runner") {
        const event = runnerEventSchema.safeParse(notif.data.params);
        if (event.success) {
          this.options.onEvent(conn.runnerId, event.data);
        } else {
          logger.warn({ error: event.error, runnerId: conn.runnerId }, "dropping malformed session/update event");
        }
      } else if (conn) {
        logger.debug({ runnerId: conn.runnerId, role: conn.role }, "dropping session/update from a non-task-runner connection");
      }
      return;
    }

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
      // Authenticate before touching any existing connection, so a rejected register can't evict a live runner.
      const auth = this.authenticate(params);
      if (!auth.ok) {
        logger.warn({ runnerId: params.runnerId, role: params.role, protocolVersion: params.protocolVersion, reason: auth.reason }, "rejected runner registration");
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
      if (existing && existingConn && (existingConn.role !== conn.role || existingConn.principalId !== conn.principalId)) {
        // Taking over would silently move a task runner's dispatch slot onto a workspace (or vice versa).
        const reason = existingConn.role !== conn.role ? "runnerId in use by another role" : "runnerId in use by another principal";
        logger.warn({ runnerId: params.runnerId, role: conn.role, liveRole: existingConn.role }, reason);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.data.id, error: { code: -32001, message: reason } }));
        ws.close(ORCH_CLOSE.replaced, reason);
        return;
      }
      if (existing && existing !== ws) {
        existing.data.runnerId = null;
        if (conn.role === "workspace") existing.close(ORCH_CLOSE.replaced, "replaced by a newer workspace connection");
        else existing.close();
      }
      if (conn.role === "workspace" && conn.principalId) {
        const previous = this.workspaces.get(conn.principalId);
        if (previous && previous !== ws && previous !== existing) {
          logger.info({ principalId: conn.principalId, runnerId: conn.runnerId }, "replacing previous workspace connection");
          previous.close(ORCH_CLOSE.replaced, "replaced by a newer workspace connection");
        }
        this.workspaces.set(conn.principalId, ws);
      }
      ws.data.runnerId = params.runnerId;
      ws.data.conn = conn;
      this.sockets.set(params.runnerId, ws);
      // Workspaces aren't task runners: keep them out of the dispatcher's live-runner set.
      if (conn.role === "task-runner") {
        this.options.onRegister?.(params.runnerId, params.kind, params.projects, params.workspaceRoot, params.location, params.capabilities, params.ownerOnly);
      }
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: req.data.id, result: { ok: true } }),
      );
      return;
    }

    if (conn?.role === "workspace" && (notif.success || req.success)) {
      logger.debug({ runnerId: conn.runnerId, method: (parsed as { method?: unknown }).method }, "no workspace handler; dropping message");
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

  private authenticate(
    params: RegisterParams,
  ): { ok: true; principalId: string | null } | { ok: false; code: number; reason: string } {
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)) {
      return { ok: false, code: ORCH_CLOSE.unsupportedVersion, reason: "unsupported protocolVersion" };
    }
    const unauthorized = { ok: false as const, code: ORCH_CLOSE.unauthorized, reason: "unauthorized" };
    if (this.refuseAllRegisters) return unauthorized;
    const grant = params.secret === undefined ? null : grantForSecret(this.secretGrants, params.secret);
    const roleSecured = Object.values(this.secretGrants).some((g) => g.roles.includes(params.role));
    if (!roleSecured) {
      // DM traffic flows over workspace connections, so those always need a secret.
      if (params.role === "workspace") return unauthorized;
      // Legacy unauthenticated task runner, but a known secret for another role is still refused.
      if (grant) return unauthorized;
      if (!this.warnedUnauthenticated) {
        this.warnedUnauthenticated = true;
        logger.warn("ORCH_RUNNER_SECRET is not set; accepting task runners without authentication");
      }
      return { ok: true, principalId: null };
    }
    if (!grant || !grant.roles.includes(params.role)) return unauthorized;
    if (params.principalId !== undefined && params.principalId !== grant.principalId) return unauthorized;
    return { ok: true, principalId: grant.principalId };
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

  start(runnerId: string, input: { taskId: string; cwd: string; prompt: string; repo?: RepoSpec | null }): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.start, input);
  }

  resume(
    runnerId: string,
    input: { taskId: string; nativeSessionId: string; cwd: string; prompt: string },
  ): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.resume, input);
  }

  interrupt(runnerId: string, taskId: string): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.interrupt, { taskId });
  }

  stopTask(runnerId: string, input: { taskId: string; discard?: boolean }): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.stop, input);
  }

  message(runnerId: string, input: { taskId: string; text: string }): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.message, input);
  }

  followUp(runnerId: string, input: { taskId: string; text: string }): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.followUp, input);
  }

  watchBrowser(runnerId: string, input: { taskId: string; watch: boolean }): Promise<unknown> {
    return this.call(runnerId, RPC_METHODS.browserWatch, input);
  }

  isConnected(runnerId: string): boolean {
    return this.sockets.has(runnerId);
  }

  getConnection(runnerId: string): ConnectionInfo | undefined {
    return this.sockets.get(runnerId)?.data.conn ?? undefined;
  }

  /** The principal's live workspace connection, if one is registered. */
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return this.workspaces.get(principalId)?.data.conn ?? undefined;
  }
}
