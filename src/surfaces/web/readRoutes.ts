import { connectorRequest, CONNECTOR_ERROR_CODE } from "../../orchestration/contracts.ts";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { ID_MAX, UNKNOWN_MODEL_CODE, historySearchParams, isCalendarDate, type HistorySearchResult } from "../../orchestration/contracts.ts";
import { WorkspaceBadResponseError, type WorkspaceLink } from "../../orchestration/workspace/link.ts";
import { RpcConnectionClosedError, RpcErrorReply, RpcTimeoutError, WorkspaceNotConnectedError } from "../../orchestration/transport/server.ts";
import { getLogger } from "../../logger.ts";
import { searchChat } from "./chatSearch.ts";
import {
  RUN_ID_RE,
  RUN_KINDS,
  RUN_STATUSES,
  SEARCH_HITS_MAX,
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  type ChatHit,
  type HistoryDayResponse,
  type HistoryDaysPage,
  type NotesHit,
  type RunDetailResponse,
  type RunsPage,
  type SearchHit,
  type SearchResponse,
  type WebFeature,
  type WorkspaceUnavailableResponse,
} from "./events.ts";
import { HISTORY_RESPONSE_MAX } from "./chatRoutes.ts";
import { NO_STORE, isJson, json, readJson } from "./http.ts";
import { runApprovals, runFiles } from "./runJoins.ts";

const log = getLogger("web/readRoutes");

/** Notes searches the bot keeps in flight at once; one more marks notes unavailable instead of queueing. */
export const NOTES_SEARCHES_MAX = 2;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** The bot checks every param but the opaque cursors, so the workspace refusing params means a stale cursor. */
const JSON_RPC_INVALID_PARAMS = -32602;

export type ReadRouteLink = Pick<WorkspaceLink, "isConnected" | "runsList" | "runsGet" | "historyDays" | "historyDay" | "historySearch" | "modelsGet" | "modelsSet" | "modelsSearch">;

export interface ReadRouteDeps {
  db: Database;
  link: ReadRouteLink;
  features: readonly WebFeature[];
  workspaceEnabled: boolean;
  now?: () => number;
  connectors?: Pick<WorkspaceLink, "connectors">;
}

export interface ReadRoutes {
  handle(req: Request, path: string): Promise<Response | null>;
}

class Unavailable extends Error {
  constructor(readonly body: WorkspaceUnavailableResponse) {
    super("workspace unavailable");
  }
}

/** Over the cap: the bot answers 502 rather than ship a multi-megabyte body to a phone. */
class TooLarge extends Error {
  constructor(readonly bytes: number) {
    super("response over the size cap");
  }
}

/** Maps a failed workspace read to the WorkspaceUnavailableResponse it answers with; null: a bug, not the workspace. */
export function unavailableFor(err: unknown): { status: number; body: WorkspaceUnavailableResponse } | null {
  if (err instanceof Unavailable) return { status: 503, body: err.body };
  if (err instanceof WorkspaceNotConnectedError || err instanceof RpcConnectionClosedError) return { status: 503, body: { offline: true } };
  if (err instanceof RpcTimeoutError) return { status: 504, body: { timeout: true } };
  if (err instanceof RpcErrorReply && err.code === JSON_RPC_METHOD_NOT_FOUND) return { status: 501, body: { unsupported: true } };
  if (err instanceof WorkspaceBadResponseError || err instanceof RpcErrorReply || err instanceof TooLarge) return { status: 502, body: { bad_response: true } };
  return null;
}

/** JSON within `cap` UTF-8 bytes. UTF-8 is at most 3 bytes per UTF-16 unit, so short bodies skip the count. */
export function cappedJson(body: unknown, cap = HISTORY_RESPONSE_MAX): Response {
  const s = JSON.stringify(body);
  if (s.length > cap / 3) {
    const bytes = Buffer.byteLength(s);
    if (bytes > cap) throw new TooLarge(bytes);
  }
  return new Response(s, { headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": NO_STORE } });
}

function csv<T extends string>(raw: string | null, allowed: readonly T[]): T[] | undefined | null {
  if (raw === null || raw === "") return undefined;
  const out = new Set<T>();
  for (const part of raw.split(",")) {
    if (!(allowed as readonly string[]).includes(part)) return null;
    out.add(part as T);
  }
  return [...out];
}

function intParam(raw: string | null, min: number, max: number): number | undefined | null {
  if (raw === null) return undefined;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

const modelsBody = z.object({ alias: z.string().min(1).max(ID_MAX), role: z.enum(["main", "fallback"]).optional() }).strict();
const notFound = () => json({ error: "not found" }, 404);
const badRequest = (error: string) => json({ error }, 400);

export function createReadRoutes(deps: ReadRouteDeps): ReadRoutes {
  const { db, link } = deps;
  const now = deps.now ?? Date.now;
  const has = (f: WebFeature) => deps.features.includes(f);
  let notesInFlight = 0;

  async function fromWorkspace<T>(call: () => Promise<T>): Promise<T> {
    if (!deps.workspaceEnabled || !link.isConnected()) throw new Unavailable({ offline: true });
    return call();
  }

  async function answer(method: string, build: () => Promise<Response>): Promise<Response> {
    try {
      return await build();
    } catch (err) {
      if (err instanceof RpcErrorReply && err.code === JSON_RPC_INVALID_PARAMS) return badRequest("invalid cursor");
      const mapped = unavailableFor(err);
      if (!mapped) {
        log.error({ err, method }, "workspace read route failed");
        return json({ error: "internal" }, 500);
      }
      const { status, body } = mapped;
      if (status === 502) log.warn({ err, method }, "workspace read answered outside the contract");
      else if (status !== 503) log.info({ method, status }, "workspace read unavailable");
      return json(body, status);
    }
  }

  function listRuns(params: URLSearchParams): Promise<Response> {
    const before = params.get("before");
    if (before !== null && !RUN_ID_RE.test(before)) return Promise.resolve(badRequest("invalid cursor"));
    const limit = intParam(params.get("limit"), 1, 50);
    const kinds = csv(params.get("kind"), RUN_KINDS);
    const statuses = csv(params.get("status"), RUN_STATUSES);
    if (limit === null) return Promise.resolve(badRequest("invalid limit"));
    if (kinds === null || statuses === null) return Promise.resolve(badRequest("invalid filter"));
    return answer("runs/list", async () => {
      const res = await fromWorkspace(() =>
        link.runsList({
          ...(before !== null ? { before } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(kinds ? { kinds } : {}),
          ...(statuses ? { statuses } : {}),
        }),
      );
      return cappedJson({ runs: res.runs, before: res.before, truncated: res.truncated } satisfies RunsPage);
    });
  }

  function getRun(runId: string, params: URLSearchParams): Promise<Response> {
    const after = params.get("after");
    if (after !== null && (after === "" || after.length > ID_MAX)) return Promise.resolve(badRequest("invalid cursor"));
    const limit = intParam(params.get("limit"), 1, 200);
    if (limit === null) return Promise.resolve(badRequest("invalid limit"));
    return answer("runs/get", async () => {
      const res = await fromWorkspace(() => link.runsGet({ runId, ...(after !== null ? { after } : {}), ...(limit !== undefined ? { limit } : {}) }));
      if (!res.found) return notFound();
      // The workspace answers for the id asked; any other id is outside the contract.
      if (res.run.runId !== runId) throw new WorkspaceBadResponseError("runs/get", undefined);
      const body: RunDetailResponse = {
        run: res.run,
        ...(res.parent ? { parent: res.parent } : {}),
        children: res.children,
        session: res.session,
        steps: res.steps,
        after: res.after,
        ...(res.evidence ? { evidence: res.evidence } : {}),
        ...(res.historyFile !== undefined ? { historyFile: res.historyFile } : {}),
        approvals: runApprovals(db, res.run, now()),
        files: runFiles(db, res.run),
      };
      return cappedJson(body);
    });
  }

  function listDays(params: URLSearchParams): Promise<Response> {
    const before = params.get("before");
    if (before !== null && !isCalendarDate(before)) return Promise.resolve(badRequest("invalid cursor"));
    const limit = intParam(params.get("limit"), 1, 60);
    if (limit === null) return Promise.resolve(badRequest("invalid limit"));
    return answer("history/days", async () => {
      const res = await fromWorkspace(() => link.historyDays({ ...(before !== null ? { before } : {}), ...(limit !== undefined ? { limit } : {}) }));
      return cappedJson({ days: res.days, before: res.before } satisfies HistoryDaysPage);
    });
  }

  function getDay(date: string): Promise<Response> {
    if (!isCalendarDate(date)) return Promise.resolve(notFound());
    return answer("history/day", async () => {
      const res = await fromWorkspace(() => link.historyDay({ date }));
      if (!res.found) return json({ found: false } satisfies HistoryDayResponse);
      if (res.date !== date) throw new WorkspaceBadResponseError("history/day", undefined);
      return cappedJson({ found: true, date: res.date, sessions: res.sessions, runs: res.runs, truncated: res.truncated } satisfies HistoryDayResponse);
    });
  }

  /** Notes hits, or null when the workspace can't search them right now. */
  async function searchNotes(query: string): Promise<HistorySearchResult | null> {
    const params = historySearchParams.safeParse({ principalId: "", query, limit: SEARCH_HITS_MAX });
    if (!params.success) return null;
    if (notesInFlight >= NOTES_SEARCHES_MAX) return null;
    notesInFlight++;
    try {
      return await fromWorkspace(() => link.historySearch({ query: params.data.query, limit: SEARCH_HITS_MAX }));
    } catch (err) {
      const mapped = unavailableFor(err);
      if (!mapped) throw err;
      if (mapped.status === 502) log.warn({ err }, "history/search answered outside the contract");
      return null;
    } finally {
      notesInFlight--;
    }
  }

  function search(params: URLSearchParams): Promise<Response> {
    const raw = params.get("q");
    const query = (raw ?? "").trim();
    const points = [...query].length;
    if (points < SEARCH_QUERY_MIN || points > SEARCH_QUERY_MAX || query.includes("\0")) return Promise.resolve(badRequest("invalid query"));
    return answer("search", () => searchBoth(query));
  }

  async function searchBoth(query: string): Promise<Response> {
    const notesCall = searchNotes(query);
    const unavailable: SearchResponse["unavailable"] = [];
    let chat: ChatHit[] = [];
    let chatMore = false;
    try {
      ({ hits: chat, more: chatMore } = searchChat(db, query, SEARCH_HITS_MAX));
    } catch (err) {
      log.error({ err }, "chat search failed");
      unavailable.push("chat");
    }
    const notes = await notesCall;
    if (!notes) unavailable.push("notes");
    const notesHits: NotesHit[] = (notes?.hits ?? []).map((h) => ({ source: "notes", ...h }));
    const sortKey = (h: SearchHit) => {
      const t = Date.parse(h.source === "notes" ? `${h.date}T23:59:59Z` : h.at);
      return Number.isFinite(t) ? t : 0;
    };
    const merged = [...chat, ...notesHits].sort((a, b) => sortKey(b) - sortKey(a));
    const truncated = chatMore || merged.length > SEARCH_HITS_MAX || (notes !== null && (notes.truncated || notes.before !== null));
    return cappedJson({ query, hits: merged.slice(0, SEARCH_HITS_MAX), truncated, unavailable } satisfies SearchResponse);
  }

  /** GET: the model choice. POST {alias}: switch from the next turn. */
  async function models(req: Request): Promise<Response> {
    if (req.method === "GET") return answer("models/get", async () => json(await fromWorkspace(() => link.modelsGet())));
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!isJson(req)) return json({ error: "expected application/json" }, 415);
    const raw = await readJson(req);
    if (raw instanceof Response) return raw;
    const body = modelsBody.safeParse(raw);
    if (!body.success) return badRequest("invalid body");
    try {
      return json(await fromWorkspace(() => link.modelsSet(body.data.alias, body.data.role)));
    } catch (err) {
      // The list changed since the app loaded it: say so, rather than blame the workspace's answer.
      if (err instanceof RpcErrorReply && err.code === UNKNOWN_MODEL_CODE) return json({ error: "unknown_model" }, 409);
      return answer("models/set", () => Promise.reject(err));
    }
  }

  return {
    async handle(req, path) {
      if (path === "/api/connectors" || path.startsWith("/api/connectors/")) {
        if (!has("connectors") || !deps.connectors) return notFound();
        let request: unknown;
        const suffix = path.slice("/api/connectors".length);
        if (req.method === "GET") request = suffix ? { action: "get", id: suffix.slice(1) } : { action: "list" };
        else if (req.method === "POST") {
          if (!isJson(req)) return json({ error: "expected application/json" }, 415);
          const body = await readJson(req);
          if (body instanceof Response) return body;
          if (suffix === "/begin" || suffix === "/finish") request = { ...(body as object), action: suffix.slice(1) };
          else {
            const match = /^\/([^/]+)\/(accept|reconnect|disconnect|remove)$/.exec(suffix);
            if (!match) return notFound();
            request = { action: match[2], id: match[1] };
          }
        } else return json({ error: "method not allowed" }, 405);
        const parsed = connectorRequest.safeParse(request);
        if (!parsed.success) return badRequest("invalid connector request");
        return answer("connectors/manage", async () => {
          try {
            const result = await fromWorkspace(() => deps.connectors!.connectors(parsed.data));
            if (result.kind === "list") return cappedJson(result.servers);
            if (result.kind === "server") return result.server ? cappedJson(result.server) : notFound();
            if (result.kind === "auth") return json({ name: result.name, authUrl: result.authUrl });
            return json({ removed: true });
          } catch (err) {
            if (err instanceof RpcErrorReply && err.code === CONNECTOR_ERROR_CODE) return json({ error: err.message }, 422);
            throw err;
          }
        });
      }
      if (path === "/api/models") return models(req);
      if (path === "/api/models/search") {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        const q = new URL(req.url).searchParams.get("q") ?? "";
        if (q.length > 100) return badRequest("query too long");
        return answer("models/search", async () => json(await fromWorkspace(() => link.modelsSearch(q))));
      }
      const runs = path === "/api/runs" || path.startsWith("/api/runs/");
      const history = path === "/api/history" || path.startsWith("/api/history/");
      const searchPath = path === "/api/search";
      if (!runs && !history && !searchPath) return null;
      if (!has(runs ? "runs" : "history")) return notFound();
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const params = new URL(req.url).searchParams;
      if (path === "/api/runs") return listRuns(params);
      if (path === "/api/history/days") return listDays(params);
      if (searchPath) return search(params);
      const run = /^\/api\/runs\/([^/]+)$/.exec(path);
      if (run) return RUN_ID_RE.test(run[1]!) ? getRun(run[1]!, params) : notFound();
      const day = /^\/api\/history\/days\/([^/]+)$/.exec(path);
      if (day) return getDay(day[1]!);
      return notFound();
    },
  };
}
