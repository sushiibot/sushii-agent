import { z } from "zod";
import { ID_MAX, JOB_NAME_RE, RUN_ID_RE, isNoReply, type RunSummary, type RunsListResult, type runsListParams } from "../../orchestration/contracts.ts";
import { LOGIN_PENDING_MS, WorkspaceBadResponseError } from "../../orchestration/workspace/link.ts";
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
/** Job failures reach Home as alerts, so only background runs are listed as failed. */
const FAILED_RUN_KINDS = ["subagent", "agent"] as const;
/** A subagent's result already went back to the agent that delegated it, which answered in chat, and a job's
 *  message is in Home's inbox. */
const REVIEW_RUN_KINDS = ["agent"] as const;
/** Generous for any background run (a job times out at 10 min), so one ending inside the window is listed. */
const RUN_MAX_LENGTH_MS = 24 * 60 * 60 * 1000;
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
    // runs/list's `since` bounds startedAt; starting earlier catches runs that began before the window and
    // ended in it, and endedAt decides below.
    const since = new Date(cutoff - RUN_MAX_LENGTH_MS).toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Enforced here too: the link's own timeout is only a hint it may not take.
    const budget = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new RpcTimeoutError("Home's workspace budget ran out")), timeoutMs)));
    try {
      // One call per group, so a page full of finished runs can't crowd failed ones out.
      const [running, failed, done] = await Promise.race([
        Promise.all([
          link.runsList({ kinds: [...HOME_RUN_KINDS], statuses: ["running"], limit: 50 }, timeoutMs),
          link.runsList({ kinds: [...FAILED_RUN_KINDS], statuses: ["failed", "timeout"], since, limit: 50 }, timeoutMs),
          link.runsList({ kinds: [...REVIEW_RUN_KINDS], statuses: ["done"], since, limit: 50 }, timeoutMs),
        ]),
        budget,
      ]);
      // The groups are the bot's to define, so kinds and statuses are checked again rather than trusted to the filter.
      const recent = (runs: RunSummary[]) => runs.filter((r) => endedAt(r) >= cutoff).sort((a, b) => endedAt(b) - endedAt(a));
      const failedRuns = recent(failed.runs).filter((r) => isKind(r, FAILED_RUN_KINDS) && (r.status === "failed" || r.status === "timeout"));
      const doneRuns = recent(done.runs).filter((r) => isKind(r, REVIEW_RUN_KINDS) && r.status === "done" && hasOutput(r));
      const dismissed = store.dismissedRuns([...failedRuns, ...doneRuns].map((r) => r.runId));
      const opened = store.openedRuns(doneRuns.map((r) => r.runId));
      return {
        state: "online",
        running: running.runs.filter((r) => isKind(r, HOME_RUN_KINDS) && r.status === "running").slice(0, HOME_RUNS_MAX),
        failedRuns: failedRuns.filter((r) => !dismissed.has(r.runId)).slice(0, HOME_RUNS_MAX),
        review: doneRuns
          .filter((r) => !dismissed.has(r.runId))
          .slice(0, HOME_RUNS_MAX)
          .map((r) => ({ ...r, read: opened.has(r.runId) })),
      };
    } catch (err) {
      if (err instanceof RpcErrorReply && err.code === JSON_RPC_METHOD_NOT_FOUND) return { state: "unsupported" };
      if (err instanceof RpcTimeoutError) return { state: "timeout" };
      if (err instanceof WorkspaceBadResponseError) {
        log.warn({ err, issues: err.issues?.issues.slice(0, 3) }, "the workspace's runs/list answer is outside the contract");
        return { state: "bad_response" };
      }
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
      inbox: store.messages(),
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
    return itemAction(body.id, (key) => store.doneMessage(key), (runId) => store.dismissRun(runId));
  }

  async function postRestore(req: Request): Promise<Response> {
    const body = await parseBody(req);
    if (body instanceof Response) return body;
    return itemAction(body.id, (key) => store.restoreMessage(key), (runId) => store.restoreRun(runId));
  }

  async function postOpened(req: Request): Promise<Response> {
    const body = await parseBody(req);
    if (body instanceof Response) return body;
    return itemAction(body.id, (key) => store.readMessage(key), (runId) => store.openRun(runId));
  }

  /** Applies a `msg:` or `run:` action. A run id the workspace may not list yet is taken as is. */
  function itemAction(id: string, onMessage: (key: string) => boolean, onRun: (runId: string) => void): Response {
    const key = /^msg:(.+)$/.exec(id)?.[1];
    if (key !== undefined) return onMessage(key) ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404);
    const runId = runIdOf(id);
    if (runId === null) return json({ error: "invalid id" }, 400);
    onRun(runId);
    return new Response(null, { status: 204 });
  }

  return {
    async handle(req, path) {
      if (path !== "/api/home" && !path.startsWith("/api/home/")) return null;
      if (path === "/api/home") return req.method === "GET" ? getHome() : methodNotAllowed();
      if (path === "/api/home/dismiss") return req.method === "POST" ? postDismiss(req) : methodNotAllowed();
      if (path === "/api/home/opened") return req.method === "POST" ? postOpened(req) : methodNotAllowed();
      if (path === "/api/home/restore") return req.method === "POST" ? postRestore(req) : methodNotAllowed();
      return json({ error: "not found" }, 404);
    },
  };
}

function isKind(r: RunSummary, kinds: readonly string[]): boolean {
  return kinds.includes(r.kind);
}

/** A run that said something: NO_REPLY (a quiet heartbeat) or no result at all leaves nothing to review. */
function hasOutput(r: RunSummary): boolean {
  const text = r.resultSummary?.trim() ?? "";
  return text !== "" && !isNoReply(text);
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
