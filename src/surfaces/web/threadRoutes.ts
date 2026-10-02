import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPresence } from "./presence.ts";
import {
  createChatRoutes,
  type ChatRoutes,
  type ChatRouteDeps,
} from "./chatRoutes.ts";
import {
  WebWorkspaceAdapter,
  type WebAdapterDeps,
} from "./workspaceAdapter.ts";
import { historyPage } from "./history.ts";
import { json, readJson } from "./http.ts";

interface ThreadRow {
  id: string;
  title: string;
  brief: string;
  created_at: number;
  archived_at: number | null;
  archived_by: "you" | "idle" | null;
  report: string | null;
  report_delivered: number;
}
export interface ThreadChannel {
  log: SqliteChatLog;
  adapter: WebWorkspaceAdapter;
  routes: ChatRoutes;
}
const branchBody = z
  .object({
    messageId: z.string().max(200),
    title: z.string().trim().min(1).max(120),
  })
  .strict();
const CAP = 8;
const IDLE_DAYS = 7;

/** Thread metadata and isolated web channels share the existing bot database. */
export class WebThreads {
  private mutation: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(fn, fn);
    this.mutation = next.catch(() => {});
    return next;
  }
  private readonly channels = new Map<string, ThreadChannel>();
  private readonly handles = new WeakMap<object, WebWorkspaceAdapter>();
  constructor(
    private readonly deps: {
      db: Database;
      main: ThreadChannel;
      link: Pick<WorkspaceLink, "topicManage" | "sendMessage">;
      chat: Omit<ChatRouteDeps, "log" | "inbound" | "adapter" | "presence">;
      adapter: Omit<WebAdapterDeps, "log" | "inbound" | "presence">;
    },
  ) {
    for (const row of this.rows())
      this.channel(row.id).log.cancelUnresolvedApprovals();
    this.deps.main.log.subscribe(null, (ev) => {
      if (
        [
          "user",
          "reply",
          "proactive",
          "ask",
          "approval",
          "turn_final",
        ].includes(ev.type)
      )
        this.changed("main");
    });
  }
  private changed(id: string) {
    this.deps.main.log.publish({ type: "threads", data: { id } });
  }
  private rows(): ThreadRow[] {
    return this.deps.db
      .query("SELECT * FROM web_threads ORDER BY created_at DESC")
      .all() as ThreadRow[];
  }
  private row(id: string): ThreadRow | null {
    return this.deps.db
      .query("SELECT * FROM web_threads WHERE id = ?")
      .get(id) as ThreadRow | null;
  }
  channel(id: string): ThreadChannel {
    if (id === "main") return this.deps.main;
    const known = this.channels.get(id);
    if (known) return known;
    if (!this.row(id)) throw new Error("unknown thread");
    const log = new SqliteChatLog(this.deps.db, { conversationId: id });
    const inbound = new WebInboundStore(this.deps.db, id);
    const presence = createPresence({ head: () => log.head() });
    const adapter = new WebWorkspaceAdapter({
      ...this.deps.adapter,
      log,
      inbound,
      presence,
    });
    const routes = createChatRoutes({
      ...this.deps.chat,
      log,
      inbound,
      presence,
      adapter,
      origin: { surface: "web", conversationId: id },
    });
    const c = { log, adapter, routes };
    this.channels.set(id, c);
    let active = false;
    log.subscribe(null, (ev) => {
      const running = adapter.openTurns().length > 0;
      if (
        running !== active ||
        [
          "user",
          "reply",
          "proactive",
          "ask",
          "ask_resolved",
          "approval",
          "approval_resolved",
          "turn_final",
        ].includes(ev.type)
      )
        this.changed(id);
      active = running;
    });
    return c;
  }
  /** One registered web surface dispatches origin-bearing calls and retains the channel in handles. */
  surface(): WebWorkspaceAdapter {
    const originMethods = new Set([
      "sendReply",
      "askPrompt",
      "authPrompt",
      "alertPrompt",
      "progressCreate",
      "turnStarted",
      "progressFinalize",
      "progressReopen",
      "approvalPrompt",
    ]);
    const handleMethods = new Set([
      "progressUpdate",
      "progressDelta",
      "resolveApproval",
    ]);
    const inboundMethods = new Set([
      "ack",
      "notice",
      "fallbackReply",
      "resetFallback",
    ]);
    return new Proxy(this.deps.main.adapter, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          let adapter = target;
          if (originMethods.has(String(key))) {
            const origin = args[0] as {
              surface?: string;
              conversationId?: string;
            } | null;
            if (origin?.surface === "web" && origin.conversationId)
              adapter = this.channel(origin.conversationId).adapter;
          } else if (inboundMethods.has(String(key))) {
            const m = args[0] as { origin: { conversationId: string } };
            adapter = this.channel(m.origin.conversationId).adapter;
          } else if (handleMethods.has(String(key))) {
            adapter = this.handles.get(args[0] as object) ?? target;
          }
          const result = Reflect.apply(
            Reflect.get(adapter, key),
            adapter,
            args,
          );
          if (
            [
              "progressCreate",
              "turnStarted",
              "progressReopen",
              "approvalPrompt",
            ].includes(String(key))
          ) {
            return Promise.resolve(result).then((handle) => {
              if (
                handle &&
                typeof handle === "object" &&
                "id" in handle &&
                typeof handle.id === "string"
              )
                this.handles.set(handle, adapter);
              return handle;
            });
          }
          return result;
        };
      },
    });
  }
  private summary(row: ThreadRow) {
    const c = this.channel(row.id);
    const latest = c.log.page(["user", "reply", "proactive"], { limit: 1 })[0];
    const pending = c.log.pending({
      approvalsSince: Date.now() - 15 * 60_000,
      asks: 10,
    });
    return {
      id: row.id,
      title: row.title,
      state: row.archived_at
        ? "archived"
        : pending.asks.length || pending.approvals.length
          ? "needs-you"
          : c.adapter.openTurns().length
            ? "running"
            : "idle",
      lastActivity: new Date(latest?.createdAt ?? row.created_at).toISOString(),
      preview: latest
        ? (latest.data as { text: string }).text.slice(0, 200)
        : "No messages yet",
      writes: 0,
      memoryTracking: false,
      ...(row.archived_at
        ? {
            archived: {
              at: new Date(row.archived_at).toISOString(),
              by: row.archived_by,
            },
          }
        : {}),
    };
  }
  private closing(row: ThreadRow) {
    const last = this.channel(row.id).log.page(["reply"], { limit: 1 })[0];
    const excerpt = last?.data.text.replace(/\s+/g, " ").trim().slice(0, 500);
    return { writes: [], line: excerpt ?? "Closed without a reply." };
  }
  private async close(row: ThreadRow, by: "you" | "idle") {
    if (row.archived_at) return JSON.parse(row.report!);
    await this.channel(row.id).routes.idle();
    await this.deps.link.topicManage({ id: row.id, action: "close" });
    const at = Date.now();
    const report = {
      sessionId: row.id,
      title: row.title,
      at,
      ...this.closing(row),
    };
    this.deps.main.log.transaction(() => {
      this.deps.db.run(
        "UPDATE web_threads SET archived_at = ?, archived_by = ?, report = ?, report_delivered = 0 WHERE id = ?",
        [at, by, JSON.stringify(report), row.id],
      );
      this.deps.main.log.append(
        "proactive",
        {
          key: `thread-report:${row.id}:${at}`,
          text: `Thread closed · ${row.title}\n\n${report.line}\n\n[Open thread](/chats/${row.id})`,
          files: [],
        },
        `thread-report:${row.id}:${at}`,
      );
    });
    this.changed(row.id);
    await this.deliverReport(this.row(row.id)!);
    return report;
  }
  private async deliverReport(row: ThreadRow) {
    if (!row.report || row.report_delivered) return;
    try {
      const report = JSON.parse(row.report) as { line: string; at?: number };
      await this.deps.link.sendMessage({
        origin: { surface: "web", conversationId: "main" },
        messageId: `thread-report:${row.id}:${report.at ?? row.archived_at}`,
        text: `Thread closed · ${row.title}\n${report.line}`,
        kind: "context",
        author: { id: "workspace", name: "Topic report" },
      });
      this.deps.db.run(
        "UPDATE web_threads SET report_delivered = 1 WHERE id = ? AND report = ?",
        [row.id, row.report],
      );
    } catch {
      /* Kept on disk; reconnect and periodic maintenance retry the same message id. */
    }
  }
  async handle(
    req: Request,
    path: string,
    actor: SurfaceActor,
    server?: { timeout(req: Request, seconds: number): void },
  ): Promise<Response | null> {
    if (
      req.method === "POST" &&
      (path === "/api/threads" ||
        /^\/api\/threads\/[^/]+\/(close|reopen|chat\/messages)$/.test(path))
    )
      return this.exclusive(() => this.handleRequest(req, path, actor, server));
    return this.handleRequest(req, path, actor, server);
  }
  private async handleRequest(
    req: Request,
    path: string,
    actor: SurfaceActor,
    server?: { timeout(req: Request, seconds: number): void },
  ): Promise<Response | null> {
    if (path === "/api/chats") {
      if (req.method !== "GET")
        return json({ error: "method not allowed" }, 405);
      const pending = this.deps.main.log.pending({
        approvalsSince: Date.now() - 15 * 60_000,
        asks: 10,
      });
      const latest = this.deps.main.log.page(["user", "reply", "proactive"], {
        limit: 1,
      })[0];
      return json({
        main: {
          state:
            pending.asks.length || pending.approvals.length
              ? "needs-you"
              : this.deps.main.adapter.openTurns().length
                ? "running"
                : "idle",
          lastActivity: new Date(latest?.createdAt ?? Date.now()).toISOString(),
          preview: latest
            ? (latest.data as { text: string }).text.slice(0, 200)
            : "Main conversation",
        },
        threads: this.rows().map((r) => this.summary(r)),
        cap: CAP,
        archiveAfterDays: IDLE_DAYS,
      });
    }
    if (path === "/api/threads") {
      if (req.method !== "POST")
        return json({ error: "method not allowed" }, 405);
      const raw = await readJson(req, 16000);
      if (raw instanceof Response) return raw;
      const body = branchBody.safeParse(raw);
      if (!body.success) return json({ error: "invalid body" }, 400);
      if (this.rows().filter((r) => !r.archived_at).length >= CAP)
        return json({ error: "Close a thread before starting another." }, 409);
      const source = body.data.messageId
        ? (this.deps.db
            .query(
              "SELECT data FROM web_events WHERE conversation_id = 'main' AND (CAST(seq AS TEXT) = ? OR key = ?) AND type IN ('user', 'reply', 'proactive') ORDER BY seq DESC LIMIT 1",
            )
            .get(body.data.messageId, body.data.messageId) as {
            data: string;
          } | null)
        : null;
      const sourceText = source
        ? (JSON.parse(source.data) as { text: string }).text
        : "";
      if (body.data.messageId && !source)
        return json(
          { error: "The message is no longer in recent history." },
          404,
        );
      const brief = {
        known: source ? [sourceText.slice(0, 10000)] : [],
        open: [body.data.title],
        recentFromMain: 0,
      };
      const id = crypto.randomUUID();
      await this.deps.link.topicManage({
        id,
        action: "create",
        title: body.data.title,
        brief: JSON.stringify(brief),
      });
      this.deps.db.run(
        "INSERT INTO web_threads (id, title, brief, created_at) VALUES (?, ?, ?, ?)",
        [id, body.data.title, JSON.stringify(brief), Date.now()],
      );
      this.changed(id);
      return json(this.summary(this.row(id)!), 201);
    }
    const match = /^\/api\/threads\/([A-Za-z0-9_-]{1,80})(?:\/(.*))?$/.exec(
      path,
    );
    if (!match) return null;
    const row = this.row(match[1]!);
    if (!row) return json({ error: "not found" }, 404);
    const sub = match[2];
    const c = this.channel(row.id);
    if (sub?.startsWith("chat/")) {
      if (row.archived_at && req.method !== "GET" && sub !== "chat/seen")
        return json({ error: "Reopen this thread to send messages." }, 409);
      return c.routes.handle(req, `/api/${sub}`, actor, server);
    }
    if (!sub && req.method === "GET")
      return json({
        summary: this.summary(row),
        brief: JSON.parse(row.brief),
        writes: [],
        history: historyPage(
          c.log,
          { limit: 40 },
          { maxBytes: 2 * 1024 * 1024 },
        ).items,
        closing: this.closing(row),
      });
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    if (sub === "close") return json(await this.close(row, "you"));
    if (sub === "reopen") {
      await this.deps.link.topicManage({ id: row.id, action: "reopen" });
      this.deps.db.run(
        "UPDATE web_threads SET archived_at = NULL, archived_by = NULL WHERE id = ?",
        [row.id],
      );
      this.changed(row.id);
      return json(this.summary(this.row(row.id)!));
    }
    return json({ error: "not found" }, 404);
  }
  workspaceConnected() {
    void this.retryReports();
    for (const c of this.channels.values()) c.routes.workspaceConnected();
  }
  publish(ev: Parameters<SqliteChatLog["publish"]>[0]) {
    for (const c of this.channels.values()) c.log.publish(ev);
  }
  private async retryReports() {
    for (const row of this.rows()) await this.deliverReport(row);
  }
  async prune() {
    await this.retryReports();
    for (const r of this.rows()) {
      const c = this.channel(r.id);
      c.log.prune(Date.now());
      if (
        !r.archived_at &&
        this.summary(r).state === "idle" &&
        Date.parse(this.summary(r).lastActivity) <
          Date.now() - IDLE_DAYS * 86400000
      ) {
        try {
          await this.exclusive(async () => {
            const row = this.row(r.id)!;
            const summary = this.summary(row);
            if (
              summary.state === "idle" &&
              Date.parse(summary.lastActivity) <
                Date.now() - IDLE_DAYS * 86400000
            )
              await this.close(row, "idle");
          });
        } catch {
          /* Offline or still working: retry at the next prune. */
        }
      }
    }
  }
  async drain() {
    await Promise.all([...this.channels.values()].map((c) => c.routes.drain()));
  }
  closeStreams() {
    for (const c of this.channels.values()) {
      c.routes.closeStreams();
      c.adapter.close();
    }
  }
}
