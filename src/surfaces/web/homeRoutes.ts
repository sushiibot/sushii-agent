import { z } from "zod";
import { ID_MAX, JOB_NAME_RE, RUN_ID_RE, type RunSummary, type RunsListResult, type runsListParams } from "../../orchestration/contracts.ts";
import { LOGIN_PENDING_MS } from "../../orchestration/workspace/link.ts";
import { APPROVAL_TIMEOUT_MS } from "../../orchestration/workspace/tools.ts";
import { RpcErrorReply, RpcTimeoutError } from "../../orchestration/transport/server.ts";
import { getLogger } from "../../logger.ts";
import type { SqliteChatLog } from "./chatLog.ts";
import { PENDING_ASKS_MAX } from "./chatRoutes.ts";
import { HOME_RECENT_HOURS, HOME_RUNS_MAX, type HomeResponse, type TurnView, type WebFeature } from "./events.ts";
import type { WebHomeStore } from "./homeStore.ts";
import { isJson, json, readJson } from "./http.ts";

const log = getLogger("web/homeRoutes");

/** How long GET /api/home waits for the workspace part before answering without it. */
export const HOME_WORKSPACE_TIMEOUT_MS = 3_000;
const HOME_RUN_KINDS = ["job", "subagent", "agent"] as const;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** The link calls Home makes. `runsList` matches WorkspaceLink.runsList. */
export interface HomeLink {
  isConnected(): boolean;
  isLoginPending(): boolean;
  runsList(q: Omit<z.input<typeof runsListParams>, "principalId">, timeoutMs?: number): Promise<RunsListResult>;
}

export interface HomeRouteDeps {
  log: SqliteChatLog;
  adapter: { openTurns(): TurnView[] };
  store: WebHomeStore;
  link: HomeLink;
  workspaceEnabled: boolean;
  features: readonly WebFeature[];
  now?: () => number;
  workspaceTimeoutMs?: number;
}

export interface HomeRoutes {
  /** Null for a path outside /api/home. */
  handle(req: Request, path: string): Promise<Response | null>;
}

const idBody = z.object({ id: z.string().min(1).max(ID_MAX) }).strict();

export function createHomeRoutes(deps: HomeRouteDeps): HomeRoutes {
  const { log: chatLog, store, link } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.workspaceTimeoutMs ?? HOME_WORKSPACE_TIMEOUT_MS;

  /** The newest sign-in link, while its login is still pending. */
  function pendingAuth(): HomeResponse["waiting"]["auth"] {
    if (!link.isLoginPending()) return null;
    const last = chatLog.list(["auth"], { since: now() - LOGIN_PENDING_MS }).at(-1);
    return last ? { seq: last.seq, at: new Date(last.createdAt).toISOString(), key: last.data.key } : null;
  }

  async function workspacePart(): Promise<HomeResponse["workspace"]> {
    if (!deps.workspaceEnabled || !link.isConnected()) return { state: "offline" };
    const t = now();
    const cutoff = t - HOME_RECENT_HOURS * 60 * 60 * 1000;
    // runs/list's `since` bounds startedAt, so finished runs are filtered on endedAt here.
    const kinds = [...HOME_RUN_KINDS];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Enforced here too: the link's own timeout is only a hint it may not take.
    const budget = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new RpcTimeoutError("Home's workspace budget ran out")), timeoutMs)));
    try {
      const [running, finished] = await Promise.race([
        Promise.all([
          link.runsList({ kinds, statuses: ["running"], limit: 50 }, timeoutMs),
          link.runsList({ kinds, statuses: ["done", "failed", "timeout"], since: new Date(cutoff).toISOString(), limit: 50 }, timeoutMs),
        ]),
        budget,
      ]);
      // The groups are the bot's to define, so kinds are checked again rather than trusted to the filter.
      const recent = finished.runs
        .filter((r) => isHomeKind(r) && endedAt(r) >= cutoff)
        .sort((a, b) => endedAt(b) - endedAt(a));
      const failed = recent.filter((r) => (r.kind === "subagent" || r.kind === "agent") && (r.status === "failed" || r.status === "timeout"));
      const done = recent.filter((r) => r.status === "done");
      const dismissed = store.dismissedRuns(failed.map((r) => r.runId));
      const opened = store.openedRuns(done.map((r) => r.runId));
      return {
        state: "online",
        running: running.runs.filter((r) => isHomeKind(r) && r.status === "running").slice(0, HOME_RUNS_MAX),
        failedRuns: failed.filter((r) => !dismissed.has(r.runId)).slice(0, HOME_RUNS_MAX),
        review: done.filter((r) => !opened.has(r.runId)).slice(0, HOME_RUNS_MAX),
      };
    } catch (err) {
      if (err instanceof RpcErrorReply && err.code === JSON_RPC_METHOD_NOT_FOUND) return { state: "unsupported" };
      if (err instanceof RpcTimeoutError) return { state: "timeout" };
      // Not connected any more, or an answer outside the contract: either way there is nothing to show.
      log.warn({ err }, "Home could not read the workspace's runs");
      return { state: "offline" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getHome(): Promise<Response> {
    const t = now();
    const pending = chatLog.pending({ approvalsSince: t - APPROVAL_TIMEOUT_MS, asks: PENDING_ASKS_MAX });
    const body: HomeResponse = {
      asOf: new Date(t).toISOString(),
      waiting: { approvals: pending.approvals, asks: pending.asks, auth: pendingAuth() },
      openTurns: deps.adapter.openTurns(),
      failed: deps.features.includes("alerts") ? store.openAlerts() : [],
      workspace: await workspacePart(),
    };
    return json(body);
  }

  async function postDismiss(req: Request): Promise<Response> {
    const body = await parseBody(req);
    if (body instanceof Response) return body;
    const job = /^job:(.+)$/.exec(body.id)?.[1];
    if (job !== undefined) {
      if (!JOB_NAME_RE.test(job)) return json({ error: "invalid id" }, 400);
      const dismissed = chatLog.transaction(() => {
        const seq = store.dismissAlert(job);
        if (seq === null) return false;
        chatLog.append("alert_cleared", { id: body.id, reason: "dismissed" }, `dismissed:${job}:${seq}`);
        return true;
      });
      return dismissed ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404);
    }
    const runId = runIdOf(body.id);
    if (runId === null) return json({ error: "invalid id" }, 400);
    store.dismissRun(runId);
    return new Response(null, { status: 204 });
  }

  async function postOpened(req: Request): Promise<Response> {
    const body = await parseBody(req);
    if (body instanceof Response) return body;
    const runId = runIdOf(body.id);
    if (runId === null) return json({ error: "invalid id" }, 400);
    store.openRun(runId);
    return new Response(null, { status: 204 });
  }

  return {
    async handle(req, path) {
      if (path !== "/api/home" && !path.startsWith("/api/home/")) return null;
      if (path === "/api/home") return req.method === "GET" ? getHome() : methodNotAllowed();
      if (path === "/api/home/dismiss") return req.method === "POST" ? postDismiss(req) : methodNotAllowed();
      if (path === "/api/home/opened") return req.method === "POST" ? postOpened(req) : methodNotAllowed();
      return json({ error: "not found" }, 404);
    },
  };
}

function isHomeKind(r: RunSummary): boolean {
  return (HOME_RUN_KINDS as readonly string[]).includes(r.kind);
}

/** -Infinity for a run with no usable endedAt, so it never counts as recent. */
function endedAt(r: RunSummary): number {
  const t = r.endedAt === undefined ? NaN : Date.parse(r.endedAt);
  return Number.isFinite(t) ? t : -Infinity;
}

function runIdOf(id: string): string | null {
  const runId = /^run:(.+)$/.exec(id)?.[1];
  return runId !== undefined && RUN_ID_RE.test(runId) ? runId : null;
}

async function parseBody(req: Request): Promise<z.infer<typeof idBody> | Response> {
  if (!isJson(req)) return json({ error: "content-type must be application/json" }, 415);
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const parsed = idBody.safeParse(raw);
  return parsed.success ? parsed.data : json({ error: "invalid body" }, 400);
}

function methodNotAllowed(): Response {
  return json({ error: "method not allowed" }, 405);
}
