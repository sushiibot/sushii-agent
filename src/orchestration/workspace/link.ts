import { BROWSER_READ, browserReadParams, browserReadResult, type BrowserReadResult } from "../browserContracts.ts";
import { memoryParams, memoryOverview, memoryDetail } from "../memoryContracts.ts";
import { runsStopParams, runsStopResult } from "../contracts.ts";
import { connectorsParams, connectorsResult, type ConnectorRequest, type ConnectorsResult } from "../contracts.ts";
import type { z } from "zod";
import {
  AUTH_METHODS,
  LOGIN_ALREADY_PENDING,
  CHAT_EXPORT_TIMEOUT_MS,
  HISTORY_SEARCH_TIMEOUT_MS,
  RPC_METHODS,
  RUNS_TIMEOUT_MS,
  WORKSPACE_FEATURES,
  historyDayParams,
  historyDayResult,
  historyDaysParams,
  historyDaysResult,
  historySearchParams,
  historySearchResult,
  runsGetParams,
  runsGetResult,
  runsListParams,
  runsListResult,
  type HistoryDayResult,
  type HistoryDaysResult,
  type HistorySearchResult,
  type RunsGetResult,
  type RunsListResult,
  topicsManageParams,
  topicsManageResult,
  chatDeliverParams,
  chatExportResult,
  runsChangedParams,
  type RunsChangedParams,
  type ChatExportParams,
  type ChatExportResult,
  type AuthCancelResult,
  type AuthCompleteResult,
  type AuthStartResult,
  chatEventParams,
  type ChatCommand,
  type ChatCommandParams,
  type ChatCommandResult,
  type ChatDeliverParams,
  type ChatEventParams,
  type ChatMessageParams,
  type ChatMessageResult,
  type ChatOrigin,
  type GitHubTokenResult,
  type UploadReadResult,
  type ToolCallResult,
  type ToolCancelResult,
  type ToolManifestEntry,
  modelsGetParams,
  modelsResult,
  modelsSearchParams,
  modelsSearchResult,
  modelsSetParams,
  type ModelsResult,
  type ModelsSearchResult,
} from "../contracts.ts";
import { MethodNotFoundError, mayHaveBeenAccepted, type ConnectionInfo, type WorkspaceHandler } from "../transport/server.ts";
import type { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { getLogger } from "../../logger.ts";
import type { GitHubTokenBroker } from "./githubToken.ts";
import { progressEditDelay, realTimers, type Timers } from "./progress.ts";
import {
  DeliveryRejectedError,
  SurfaceUnavailableError,
  type AckKind,
  type AskView,
  type AuthPromptView,
  type InboundMessage,
  type PageLedger,
  type ProgressFinal,
  type ProgressView,
  type ReplyView,
  type ResolvedSurface,
  type RouterNotice,
  type SurfaceActor,
  type SurfaceAdapter,
  type SurfaceMessageHandle,
  type SurfaceRegistry,
  type ToolLine,
  type TurnOutcome,
} from "./surface.ts";

const log = getLogger("orchestration/workspace/link");

/** The workspace answered a read with something outside the contract. */
export class WorkspaceBadResponseError extends Error {
  constructor(
    readonly method: string,
    readonly issues?: z.ZodError,
  ) {
    super(`${method}: response outside the contract`);
  }
}

export const MESSAGE_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 30_000;
// The workspace bounds the whole chat/new, memory flush included, at 3m30s (NEW_BUDGET_MS).
const NEW_SESSION_TIMEOUT_MS = 240_000;
/** Tool lines kept per persisted progress view. */
const PERSISTED_LINES = 8;
const OUTBOX_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENDED_TURNS_KEPT = 100;
// One main turn runs at a time; more open views than this are stale or a workspace flooding turnIds.
export const MAX_OPEN_TURNS = 20;
/** Consecutive failed sends of one delivery before it goes out as plain text instead. */
export const DELIVERY_MAX_FAILURES = 3;
/** chat/message id of an ask's answer: one per ask, whichever surface or button answered it, so the
 *  workspace collapses a second answer as a duplicate. */
export const ASK_ANSWER_ID_PREFIX = "wsask:";

/** How long the bot treats a pasted callback URL as the login's; matches the workspace's login timeout. */
export const LOGIN_PENDING_MS = 10 * 60_000;
// The token exchange runs inside auth/complete.
const AUTH_COMPLETE_TIMEOUT_MS = 60_000;
const LOGIN_PENDING_KV_PREFIX = "workspace:login_pending:";

const APPROVAL_REPLY_RE = /^(approve|deny)\s+(\S+)$/i;
const CHOICE_REPLY_RE = /^\d{1,2}$/;

/** The slice of OrchestrationServer the link drives; tests supply a fake. */
export interface WorkspaceRpc {
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined;
  requestWorkspace(principalId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  setWorkspaceHandler(handler: WorkspaceHandler | null): void;
}

export interface WorkspaceToolsPort {
  manifest(): ToolManifestEntry[];
  handleCall(conn: ConnectionInfo, params: unknown): Promise<ToolCallResult>;
  handleCancel(conn: ConnectionInfo, params: unknown): ToolCancelResult;
  onSocketClosed(conn: ConnectionInfo): void;
  /** An owner's text reply to a buttonless approval prompt; true when it settled a pending approval. */
  decideByCode?(code: string, decision: "approve" | "deny", actor: SurfaceActor): boolean;
}

export type StopTurnResult = { status: "forbidden" } | { status: "failed"; error: string } | { status: "ok"; aborted: boolean; final: ProgressFinal | null };

export type AnswerAskResult =
  | { status: "forbidden" }
  | { status: "inactive" }
  | { status: "answered" | "duplicate"; answer: string }
  | { status: "failed"; answer: string; error: string };

/** A choice picked by index (a button, or a number typed on a surface without buttons), or free text. */
export type AskChoice = { index: number; label?: string | null } | { text: string };

/** Whether the core consumed an inbound reply itself; a consumed one never reaches the workspace. */
export type InterceptResult = { handled: false } | { handled: true; ack?: AckKind; notice?: RouterNotice };

export type StartLoginResult = { status: "started" | "alreadyPending" | "offline" } | { status: "failed"; error: string };
/** "ended": the login finished (either way) and its result arrives as a delivery; "inactive": no login was running;
 *  "rejected": the paste was turned away and the login is still pending. */
export type CompleteLoginResult = { status: "ok" | "ended" | "inactive" | "offline" } | { status: "failed" | "rejected"; error: string };
export type CancelLoginResult = { status: "cancelled" | "notPending" | "offline" } | { status: "failed"; error: string };

/** Log sink for the login path; its callers never pass the pasted input. */
export interface AuthLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Runs once an action passed its checks and before its slow part, e.g. to defer an interaction. */
export interface ActionHooks {
  onAccepted?: () => Promise<unknown>;
}

export interface WorkspaceLinkOptions {
  principalId: string;
  /** Absent until attach(); without one the workspace is always offline. */
  rpc?: WorkspaceRpc | null;
  store: WorkspaceLinkStore;
  surfaces: SurfaceRegistry;
  /** Author attached to replayed inbox context. */
  owner: () => { id: string; name: string };
  now?: () => number;
  timers?: Timers;
  /** Serves `tool/call` and the register result's tool manifest; absent → no tools offered. */
  tools?: WorkspaceToolsPort;
  /** Whether `actor` is the principal. Default: the owner's id, on any surface; an empty id matches nobody. */
  isOwner?: (actor: SurfaceActor) => boolean;
  /** DM_WORKSPACE_ENABLED. When false the link still drains a connected workspace's deliveries (say, a
   *  reply outboxed before a rollback) but offers and serves no tools. Default true. */
  enabled?: boolean;
  /** Where the login path logs; default the module logger. */
  authLog?: AuthLog;
  /** Serves `github/token`; absent → every request is refused as unconfigured. */
  github?: Pick<GitHubTokenBroker, "handle">;
  /** Serves `upload/read`; absent → every request is refused. */
  uploadRead?: (conn: ConnectionInfo, params: unknown) => Promise<UploadReadResult>;
}

const MAIN_AGENT = "main";
const PROGRESS_KV_PREFIX = "workspace:progress:";
const ENDED_COUNTS_PERSISTED = 20;

type OpenView = { turnId: string; messageId: string; startedAt: number; toolCount: number; lines: ToolLine[]; origin?: ChatOrigin | null };

/** What survives a restart: open progress views (to finalize or keep driving) and recent tool counts. */
interface ProgressSnapshot {
  open: OpenView[];
  ended: Array<[string, number]>;
}

interface TurnProgress {
  modelActivity?: "waiting" | "thinking";
  turnId: string;
  /** Where the turn's message came from; null for the preferred surface. */
  origin: ChatOrigin | null;
  startedAt: number;
  lines: ToolLine[];
  toolCount: number;
  text: string;
  message: Promise<SurfaceMessageHandle | null> | null;
  messageId: string | null;
  /** The adapter the view was made by, resolved once so its handle never goes to another adapter. */
  target: ResolvedSurface | null;
  /** Rebuilt from the snapshot of an earlier process. */
  restored: boolean;
  // Serializes edits so a late in-flight edit can't overwrite the terminal state.
  chain: Promise<unknown>;
  lastEditAt: number;
  timer: unknown;
}

export type DeliveryView = { type: "reply"; view: ReplyView } | { type: "ask"; view: AskView } | { type: "auth"; view: AuthPromptView };

/** The surface-neutral view of a delivery. Blank ask choices get a placeholder label, since the label is
 *  also the answer text. */
export function deliveryView(p: ChatDeliverParams, toolCount: number | null = null): DeliveryView {
  if (p.kind === "ask") {
    const choices = (p.ask?.choices ?? []).map((c, i) => (c.trim() ? c : `(option ${i + 1})`));
    return { type: "ask", view: { askId: p.ask?.askId ?? null, question: p.ask?.question ?? p.text, choices, ...(p.ask?.toolConfirmation ? { toolConfirmation: p.ask.toolConfirmation } : {}) } };
  }
  if (p.kind === "auth" && p.auth) return { type: "auth", view: { url: p.auth.url, instructions: p.auth.instructions } };
  return {
    type: "reply",
    view: {
      // A surface without alertPrompt shows an alert as its plain-text proactive message.
      kind: p.kind === "proactive" || p.kind === "alert" ? "proactive" : "reply",
      text: p.text,
      toolCount,
      ...(p.usage ? { usage: p.usage } : {}),
      ...(p.turnId ? { turnId: p.turnId } : {}),
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
      ...(p.files?.length ? { files: p.files } : {}),
      ...(p.job ? { job: p.job } : {}),
    },
  };
}

/** Bot side of the personal-agent workspace chat protocol, surface-neutral: sends the principal's messages
 *  to the workspace, and routes its live progress and deliveries to the surface each one came from. */
export class WorkspaceLink {
  private readonly opts: WorkspaceLinkOptions;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly turns = new Map<string, TurnProgress>();
  private readonly delivering = new Set<string>();
  private readonly askChoices = new Map<string, string[]>();
  // Surface id → the ask whose choices a bare number answers there; only surfaces without buttons.
  private readonly numberedAsks = new Map<string, { askId: string; count: number }>();
  private connectWaiters: Array<() => void> = [];
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly runListeners = new Set<(p: RunsChangedParams) => void>();
  private replaying: Promise<void> | null = null;
  private replayAgain = false;
  // turnId → tool count for turns that have ended; null when the count is unknown (a restart).
  private readonly endedTurns = new Map<string, number | null>();
  private rpc: WorkspaceRpc | null;
  // Progress views an earlier process left open, picked up on the first register.
  private orphans: OpenView[];
  // Restored views finalized as interrupted at an idle register; their reply may still arrive to mark them done.
  private readonly interruptedRestored = new Map<string, TurnProgress>();

  constructor(opts: WorkspaceLinkOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.rpc = opts.rpc ?? null;
    const snapshot = this.loadProgress();
    this.orphans = snapshot.open;
    for (const [turnId, count] of snapshot.ended) this.endedTurns.set(turnId, count);
  }

  private get toolsEnabled(): boolean {
    return this.opts.enabled !== false && this.opts.tools !== undefined;
  }

  get principalId(): string {
    return this.opts.principalId;
  }

  get surfaces(): SurfaceRegistry {
    return this.opts.surfaces;
  }

  /** Installs the server hooks; call before the orchestration server starts listening. */
  attach(rpc: WorkspaceRpc): void {
    this.rpc = rpc;
    rpc.setWorkspaceHandler(this.handler());
  }

  handler(): WorkspaceHandler {
    return {
      onRegister: (conn) => this.onRegister(conn),
      onDisconnect: (conn) => {
        if (conn.principalId !== this.opts.principalId) return;
        log.info({ runnerId: conn.runnerId }, "workspace disconnected");
        this.notifyConnection();
      },
      onSocketClosed: (conn) => this.opts.tools?.onSocketClosed(conn),
      toolManifest: (conn) => (conn.principalId === this.opts.principalId && this.toolsEnabled ? this.opts.tools!.manifest() : []),
      // Advertised whatever WEB_FEATURES says: a surface without alertPrompt still shows an alert as its text.
      features: (conn) => (conn.principalId === this.opts.principalId ? [...WORKSPACE_FEATURES] : []),
      onRequest: (conn, method, params) => this.onRequest(conn, method, params),
      onNotification: (conn, method, params) => this.onNotification(conn, method, params),
    };
  }

  /** Called with each `runs/changed` notification from the principal's workspace; returns an unsubscribe. */
  onRunsChanged(listener: (p: RunsChangedParams) => void): () => void {
    this.runListeners.add(listener);
    return () => void this.runListeners.delete(listener);
  }

  /** Called on every register and disconnect of the principal's workspace; returns an unsubscribe. */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => void this.connectionListeners.delete(listener);
  }

  private notifyConnection(): void {
    const connected = this.isConnected();
    for (const l of [...this.connectionListeners]) {
      try {
        l(connected);
      } catch (err) {
        log.warn({ err }, "workspace connection listener threw");
      }
    }
  }

  /** One page of the Main transcript for the import. An old workspace without the method rejects with MethodNotFound. */
  async chatExport(q: Omit<ChatExportParams, "principalId">): Promise<ChatExportResult> {
    const params: ChatExportParams = { principalId: this.opts.principalId, ...q };
    return chatExportResult.parse(await this.request(RPC_METHODS.chatExport, params, CHAT_EXPORT_TIMEOUT_MS));
  }

  /** `timeoutMs` lets Home answer within its own budget. */
  async runsList(q: Omit<z.input<typeof runsListParams>, "principalId">, timeoutMs = RUNS_TIMEOUT_MS): Promise<RunsListResult> {
    return this.read(RPC_METHODS.runsList, runsListParams, runsListResult, q, timeoutMs);
  }

  async runsGet(q: Omit<z.input<typeof runsGetParams>, "principalId">): Promise<RunsGetResult> {
    return this.read(RPC_METHODS.runsGet, runsGetParams, runsGetResult, q, RUNS_TIMEOUT_MS);
  }

  async browserRead(conversationId: string, frames = false): Promise<BrowserReadResult> {
    return this.read(BROWSER_READ, browserReadParams, browserReadResult, { conversationId, frames }, 5000);
  }

  async memoryRead(id?: string) {
    return id === undefined ? this.read("memory/read", memoryParams, memoryOverview, {}, RUNS_TIMEOUT_MS) : this.read("memory/read", memoryParams, memoryDetail, { id }, RUNS_TIMEOUT_MS);
  }

  async historyDays(q: Omit<z.input<typeof historyDaysParams>, "principalId">): Promise<HistoryDaysResult> {
    return this.read(RPC_METHODS.historyDays, historyDaysParams, historyDaysResult, q, RUNS_TIMEOUT_MS);
  }

  async historyDay(q: Omit<z.input<typeof historyDayParams>, "principalId">): Promise<HistoryDayResult> {
    return this.read(RPC_METHODS.historyDay, historyDayParams, historyDayResult, q, RUNS_TIMEOUT_MS);
  }

  async historySearch(q: Omit<z.input<typeof historySearchParams>, "principalId">): Promise<HistorySearchResult> {
    return this.read(RPC_METHODS.historySearch, historySearchParams, historySearchResult, q, HISTORY_SEARCH_TIMEOUT_MS);
  }

  async connectors(request: ConnectorRequest): Promise<ConnectorsResult> {
    return this.read(RPC_METHODS.connectors, connectorsParams, connectorsResult, { request }, 60_000);
  }

  async runsStop(runId: string): Promise<{ stopped: boolean }> {
    return this.read(RPC_METHODS.runsStop, runsStopParams, runsStopResult, { runId }, CONTROL_TIMEOUT_MS);
  }

  async topicManage(q: { id: string; action: "create" | "close" | "reopen" | "rename"; title?: string; brief?: string }): Promise<void> {
    await this.read(RPC_METHODS.topicsManage, topicsManageParams, topicsManageResult, q, NEW_SESSION_TIMEOUT_MS);
  }

  async modelsGet(conversationId?: string): Promise<ModelsResult> {
    return this.read(RPC_METHODS.modelsGet, modelsGetParams, modelsResult, conversationId ? { conversationId } : {}, CONTROL_TIMEOUT_MS);
  }

  /** Switches the owner's model, or the ChatGPT fallback, from the next turn, as `!model <alias>` does. */
  async modelsSet(alias: string, role: "main" | "fallback" = "main"): Promise<ModelsResult> {
    return this.read(RPC_METHODS.modelsSet, modelsSetParams, modelsResult, { alias, ...(role === "fallback" ? { role } : {}) }, CONTROL_TIMEOUT_MS);
  }

  async modelsSearch(query: string): Promise<ModelsSearchResult> {
    return this.read(RPC_METHODS.modelsSearch, modelsSearchParams, modelsSearchResult, { query }, RUNS_TIMEOUT_MS);
  }

  /** A read-only workspace request. Run and history content is agent-writable, so a result outside the
   *  contract rejects the whole response with WorkspaceBadResponseError. */
  private async read<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(method: string, params: P, result: R, q: object, timeoutMs: number): Promise<z.infer<R>> {
    const raw = await this.request(method, params.parse({ ...q, principalId: this.opts.principalId }), timeoutMs);
    const parsed = result.safeParse(raw);
    if (!parsed.success) throw new WorkspaceBadResponseError(method, parsed.error);
    return parsed.data;
  }

  isConnected(): boolean {
    return this.rpc?.getWorkspaceConnection(this.opts.principalId) !== undefined;
  }

  /** Resolves true once the workspace is connected, or false after `timeoutMs`. */
  waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    if (!this.rpc) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = () => {
        this.timers.clear(handle);
        resolve(true);
      };
      const handle = this.timers.set(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      this.connectWaiters.push(waiter);
    });
  }

  async sendMessage(input: Omit<ChatMessageParams, "principalId">): Promise<ChatMessageResult> {
    const fileUploads = this.tryTarget(undefined, input.origin)?.adapter.capabilities.fileUploads === true;
    const params: ChatMessageParams = { principalId: this.opts.principalId, ...input, ...(fileUploads ? { fileUploads } : {}) };
    return (await this.request(RPC_METHODS.chatMessage, params, MESSAGE_TIMEOUT_MS)) as ChatMessageResult;
  }

  /** With a turnId, the workspace aborts only that turn and answers aborted:false once it has ended. */
  async abort(turnId?: string, origin?: ChatOrigin): Promise<{ aborted: boolean }> {
    const params = { principalId: this.opts.principalId, ...(turnId ? { turnId } : {}), ...(origin ? { origin } : {}) };
    return (await this.request(RPC_METHODS.chatAbort, params, CONTROL_TIMEOUT_MS)) as { aborted: boolean };
  }

  /** Whether this process is still showing the turn as working. */
  hasTurn(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  /** Records a turn a Stop button finalized outside the event stream, so its turn_end adds no second message. */
  markTurnEnded(turnId: string): void {
    this.rememberEnded(turnId, null);
    this.persistProgress();
  }

  async newSession(origin?: ChatOrigin): Promise<{ sessionFile: string }> {
    return (await this.request(RPC_METHODS.chatNew, { principalId: this.opts.principalId, ...(origin ? { origin } : {}) }, NEW_SESSION_TIMEOUT_MS)) as { sessionFile: string };
  }

  /** An owner command the workspace answers itself; `!compact` includes a memory flush, hence the long timeout. */
  async command(command: ChatCommand, args?: string, origin?: ChatOrigin): Promise<ChatCommandResult> {
    const params: ChatCommandParams = { principalId: this.opts.principalId, command, ...(args ? { args } : {}), ...(origin ? { origin } : {}) };
    return (await this.request(RPC_METHODS.chatCommand, params, NEW_SESSION_TIMEOUT_MS)) as ChatCommandResult;
  }

  /** Records an exchange the in-process fallback answered, for replay into the workspace's history. */
  recordOffline(userText: string, replyText: string, origin: ChatOrigin): void {
    this.opts.store.addInbox(this.opts.principalId, userText, replyText, this.now(), origin);
    // It may have connected while the fallback was answering, after this register's replay ran.
    if (this.isConnected()) void this.replayInbox();
  }

  /** Answer text for an ask button, from memory or (after a restart) the button's label. */
  askChoice(askId: string, index: number, label: string | null): string | null {
    return this.askChoices.get(askId)?.[index] ?? label;
  }

  isOwner(actor: SurfaceActor): boolean {
    if (this.opts.isOwner) return this.opts.isOwner(actor);
    const id = this.opts.owner().id;
    return id !== "" && actor.userId === id;
  }

  /** The owner's Stop on a turn's progress view: aborts only that turn. A turn this process no longer
   *  tracks (its view outlived a restart) gets no further events, so its final state is returned for the
   *  caller to render. */
  async stopTurn(origin: ChatOrigin, turnId: string, actor: SurfaceActor, hooks: ActionHooks = {}): Promise<StopTurnResult> {
    if (!this.isOwner(actor)) return { status: "forbidden" };
    await hooks.onAccepted?.();
    const tracked = this.hasTurn(turnId);
    let aborted: boolean;
    try {
      aborted = (await this.abort(turnId, origin)).aborted;
    } catch (err) {
      log.warn({ err, turnId, surface: origin.surface }, "stop failed");
      return { status: "failed", error: errorText(err) };
    }
    if (tracked) return { status: "ok", aborted, final: null };
    this.markTurnEnded(turnId);
    return { status: "ok", aborted, final: { outcome: aborted ? "stopped" : "interrupted", summary: null } };
  }

  /** The owner's answer to an ask, sent to the workspace as a user message from `origin`. */
  async answerAsk(origin: ChatOrigin, askId: string, choice: AskChoice, actor: SurfaceActor, hooks: ActionHooks = {}): Promise<AnswerAskResult> {
    if (!this.isOwner(actor)) return { status: "forbidden" };
    const answer = !askId ? null : "text" in choice ? choice.text.trim() || null : this.askChoice(askId, choice.index, choice.label ?? null);
    if (!answer) return { status: "inactive" };
    await hooks.onAccepted?.();
    try {
      const res = await this.sendMessage({
        origin,
        messageId: `${ASK_ANSWER_ID_PREFIX}${askId}`,
        text: answer,
        kind: "user",
        author: { id: actor.userId, name: actor.name },
      });
      for (const [surface, ask] of this.numberedAsks) if (ask.askId === askId) this.numberedAsks.delete(surface);
      return { status: res.mode === "duplicate" ? "duplicate" : "answered", answer };
    } catch (err) {
      return { status: "failed", answer, error: errorText(err) };
    }
  }

  /** Consumes a reply that answers a prompt on a surface without buttons: `approve <code>` / `deny <code>`
   *  for an approval, or a choice's number for the latest numbered ask there. On surfaces with buttons
   *  nothing is consumed. An approval reply with a dead code is still consumed, so it never reaches the agent. */
  async interceptReply(message: InboundMessage): Promise<InterceptResult> {
    const surface = message.origin.surface;
    const adapter = this.opts.surfaces.get(surface);
    if (!adapter || adapter.capabilities.richButtons) return { handled: false };
    const text = message.text.trim();
    const actor: SurfaceActor = message.actor ?? { surface, userId: message.author.id, name: message.author.name };
    const approval = APPROVAL_REPLY_RE.exec(text);
    if (approval) {
      const decision = approval[1]!.toLowerCase() as "approve" | "deny";
      const decided = this.opts.tools?.decideByCode?.(approval[2]!, decision, actor) ?? false;
      return decided ? { handled: true, ack: "accepted" } : { handled: true, notice: { type: "approvalExpired" } };
    }
    const ask = this.numberedAsks.get(surface);
    if (!ask || !CHOICE_REPLY_RE.test(text)) return { handled: false };
    const n = Number(text);
    if (n < 1 || n > ask.count) return { handled: false };
    const res = await this.answerAsk(message.origin, ask.askId, { index: n - 1 }, actor);
    switch (res.status) {
      case "answered":
        return { handled: true, ack: "accepted" };
      case "duplicate":
        return { handled: true, notice: { type: "askAlreadyAnswered" } };
      case "failed":
        return { handled: true, notice: { type: "askNotDelivered", error: res.error } };
      case "forbidden":
        return { handled: true };
      case "inactive":
        return { handled: false };
    }
  }

  // ── ChatGPT sign-in ────────────────────────────────────────────────────────

  private get authLog(): AuthLog {
    return this.opts.authLog ?? log;
  }

  private loginKey(): string {
    return `${LOGIN_PENDING_KV_PREFIX}${this.opts.principalId}`;
  }

  /** Persisted, so a callback pasted across a bot restart is still kept from the agent. `loginId` is null
   *  until the workspace names it. */
  private pendingLogin(): { until: number; loginId: string | null } | null {
    const raw = this.opts.store.getKv(this.loginKey());
    if (raw === null) return null;
    let pending: { until: number; loginId: string | null };
    try {
      const parsed = JSON.parse(raw) as unknown;
      pending =
        typeof parsed === "number"
          ? { until: parsed, loginId: null }
          : { until: Number((parsed as { until?: unknown }).until) || 0, loginId: typeof (parsed as { loginId?: unknown }).loginId === "string" ? (parsed as { loginId: string }).loginId : null };
    } catch {
      pending = { until: 0, loginId: null };
    }
    if (pending.until > this.now()) return pending;
    this.clearLoginPending();
    return null;
  }

  isLoginPending(): boolean {
    return this.pendingLogin() !== null;
  }

  private setLoginPending(loginId: string | null): void {
    this.opts.store.setKv(this.loginKey(), JSON.stringify({ until: this.now() + LOGIN_PENDING_MS, loginId }));
  }

  private clearLoginPending(): void {
    this.opts.store.deleteKv(this.loginKey());
  }

  /** A first-seen sign-in link marks its login pending; from then on only that login's result ends it. */
  private onAuthDelivery(p: ChatDeliverParams): void {
    if (p.kind === "auth") this.setLoginPending(p.loginId ?? this.pendingLogin()?.loginId ?? null);
    if (p.authResult && p.loginId && this.pendingLogin()?.loginId === p.loginId) this.clearLoginPending();
  }

  /** Pending is set before auth/start is sent: its sign-in link can arrive even when the answer is lost. */
  async startLogin(origin: ChatOrigin): Promise<StartLoginResult> {
    if (!this.isConnected()) return { status: "offline" };
    const wasPending = this.isLoginPending();
    if (!wasPending) this.setLoginPending(null);
    let res: Partial<AuthStartResult> | undefined;
    try {
      res = (await this.request(AUTH_METHODS.start, { principalId: this.opts.principalId, provider: "openai", origin }, CONTROL_TIMEOUT_MS)) as Partial<AuthStartResult> | undefined;
    } catch (err) {
      const error = errorText(err);
      if (error.includes(LOGIN_ALREADY_PENDING)) {
        if (!this.isLoginPending()) this.setLoginPending(null);
        return { status: "alreadyPending" };
      }
      if (!wasPending && !mayHaveBeenAccepted(err)) this.clearLoginPending();
      this.authLog.warn({ error }, "auth/start failed");
      return { status: "failed", error };
    }
    const loginId = typeof res?.loginId === "string" ? res.loginId : null;
    const current = this.pendingLogin();
    if (loginId !== null || !current) this.setLoginPending(loginId ?? current?.loginId ?? null);
    this.authLog.info({ surface: origin.surface, loginId }, "ChatGPT login started");
    return { status: "started" };
  }

  /** Passes the pasted callback URL to the workspace's login. `input` is never logged. */
  async completeLogin(input: string): Promise<CompleteLoginResult> {
    if (!this.isConnected()) return { status: "offline" };
    let res: AuthCompleteResult;
    try {
      res = (await this.request(AUTH_METHODS.complete, { principalId: this.opts.principalId, input }, AUTH_COMPLETE_TIMEOUT_MS)) as AuthCompleteResult;
    } catch (err) {
      const error = errorText(err);
      this.authLog.warn({ error }, "auth/complete failed");
      return { status: "failed", error };
    }
    if (!res.ok && res.retry) {
      this.authLog.info({ reason: res.error }, "pasted ChatGPT callback rejected; login still pending");
      return { status: "rejected", error: res.error };
    }
    this.clearLoginPending();
    if (res.ok) {
      this.authLog.info({ model: res.model }, "ChatGPT login completed");
      return { status: "ok" };
    }
    this.authLog.warn({ inactive: res.inactive === true }, "ChatGPT login ended without a credential");
    return { status: res.inactive ? "inactive" : "ended" };
  }

  async cancelLogin(): Promise<CancelLoginResult> {
    if (!this.isConnected()) return { status: "offline" };
    let res: AuthCancelResult;
    try {
      res = (await this.request(AUTH_METHODS.cancel, { principalId: this.opts.principalId }, CONTROL_TIMEOUT_MS)) as AuthCancelResult;
    } catch (err) {
      const error = errorText(err);
      this.authLog.warn({ error }, "auth/cancel failed");
      return { status: "failed", error };
    }
    this.clearLoginPending();
    return { status: res.cancelled ? "cancelled" : "notPending" };
  }

  pruneOutboxSeen(): void {
    this.opts.store.pruneOutboxSeen(OUTBOX_SEEN_TTL_MS, this.now());
  }

  /** Sends each offline exchange oldest-first as context, deleting a row once the workspace accepts it. */
  replayInbox(): Promise<void> {
    // A pass already running may be bound to a socket that is being replaced; run once more after it.
    if (this.replaying) {
      this.replayAgain = true;
      return this.replaying;
    }
    this.replaying = (async () => {
      try {
        do {
          this.replayAgain = false;
          await this.replayOnce();
        } while (this.replayAgain && this.isConnected());
      } finally {
        this.replaying = null;
      }
    })();
    return this.replaying;
  }

  private async replayOnce(): Promise<void> {
    try {
      for (const row of this.opts.store.listInbox(this.opts.principalId)) {
        const params: ChatMessageParams = {
          principalId: this.opts.principalId,
          // Rows recorded before origins were stored have no conversation; the empty id says so.
          origin: row.origin ?? { surface: this.opts.surfaces.preferredSurface, conversationId: "" },
          messageId: `inbox:${row.id}`,
          text: `User: ${row.userText}\nAssistant (offline fallback): ${row.replyText}`,
          kind: "context",
          author: this.opts.owner(),
        };
        await this.request(RPC_METHODS.chatMessage, params, CONTROL_TIMEOUT_MS);
        this.opts.store.deleteInbox(row.id);
      }
    } catch (err) {
      log.warn({ err }, "inbox replay stopped; the rest resends on the next register");
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.rpc) return Promise.reject(new Error("orchestration server unavailable"));
    return this.rpc.requestWorkspace(this.opts.principalId, method, params, timeoutMs);
  }

  /** The adapter for `origin`; an unregistered surface falls back to the preferred one. */
  private surfaceFor(origin: ChatOrigin | null | undefined): { adapter: SurfaceAdapter; origin: ChatOrigin | null } {
    const resolved = this.opts.surfaces.resolve(origin);
    if (origin && resolved.origin === null) log.warn({ surface: origin.surface }, "no adapter for the origin surface; using the preferred surface");
    return resolved;
  }

  /** The turn's surface, resolved on first use and then fixed for the turn. */
  private targetOf(turn: TurnProgress): ResolvedSurface {
    turn.target ??= this.surfaceFor(turn.origin);
    return turn.target;
  }

  private tryTarget(turn: TurnProgress | undefined, origin: ChatOrigin | null): ResolvedSurface | null {
    try {
      return turn ? this.targetOf(turn) : this.opts.surfaces.resolve(origin);
    } catch {
      return null;
    }
  }

  private onRegister(conn: ConnectionInfo): void {
    if (conn.principalId !== this.opts.principalId) return;
    log.info({ runnerId: conn.runnerId, state: conn.state }, "workspace registered");
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w();
    this.notifyConnection();
    this.restoreOrphans(conn.state === "streaming");
    // An idle workspace has no run in flight, so any turn still shown as working ended unobserved.
    if (conn.state === "idle") {
      for (const turn of [...this.turns.values()]) this.finishTurn(turn, "interrupted");
    }
    void this.replayInbox();
  }

  /** Takes over the progress views an earlier process left open. Inserted synchronously so an event for
   *  the same turn edits the existing message instead of opening a second one. A restored view never
   *  sends a new message: when its message can't be reopened, its edits are dropped. */
  private restoreOrphans(streaming: boolean): void {
    const orphans = this.orphans;
    this.orphans = [];
    if (!orphans.length) return;
    for (const o of orphans) {
      if (this.turns.has(o.turnId) || this.endedTurns.has(o.turnId)) continue;
      const turn: TurnProgress = {
        turnId: o.turnId,
        origin: o.origin ?? null,
        startedAt: o.startedAt,
        lines: o.lines,
        toolCount: o.toolCount,
        text: "",
        message: null,
        messageId: o.messageId,
        target: null,
        restored: true,
        chain: Promise.resolve(),
        lastEditAt: 0,
        timer: null,
      };
      turn.message = Promise.resolve()
        .then(() => {
          const s = this.targetOf(turn);
          return s.adapter.progressReopen(s.origin, o.messageId);
        })
        .catch(() => null);
      turn.chain = turn.message;
      this.turns.set(o.turnId, turn);
      if (!streaming) {
        this.interruptedRestored.set(o.turnId, turn);
        this.finishTurn(turn, "interrupted");
      }
    }
    log.info({ count: orphans.length, streaming }, "took over progress views from before a restart");
  }

  private progressKey(): string {
    return `${PROGRESS_KV_PREFIX}${this.opts.principalId}`;
  }

  private loadProgress(): ProgressSnapshot {
    try {
      const raw = this.opts.store.getKv(this.progressKey());
      const parsed = raw ? (JSON.parse(raw) as Partial<ProgressSnapshot>) : {};
      return { open: Array.isArray(parsed.open) ? parsed.open : [], ended: Array.isArray(parsed.ended) ? parsed.ended : [] };
    } catch (err) {
      log.warn({ err }, "ignoring an unreadable progress snapshot");
      return { open: [], ended: [] };
    }
  }

  private persistProgress(): void {
    const open: OpenView[] = [...this.turns.values()]
      .filter((t) => t.messageId !== null)
      .map((t) => ({
        turnId: t.turnId,
        messageId: t.messageId!,
        startedAt: t.startedAt,
        toolCount: t.toolCount,
        lines: t.lines.slice(-PERSISTED_LINES),
        ...(t.origin ? { origin: t.origin } : {}),
      }));
    // Views not yet taken over stay persisted until a register restores them.
    for (const o of this.orphans) if (!this.turns.has(o.turnId)) open.push(o);
    const ended = [...this.endedTurns].filter((e): e is [string, number] => e[1] !== null).slice(-ENDED_COUNTS_PERSISTED);
    try {
      this.opts.store.setKv(this.progressKey(), JSON.stringify({ open, ended } satisfies ProgressSnapshot));
    } catch (err) {
      log.warn({ err }, "failed to persist workspace progress");
    }
  }

  private async onRequest(conn: ConnectionInfo, method: string, params: unknown): Promise<unknown> {
    if (method === RPC_METHODS.toolCall && this.toolsEnabled) return this.opts.tools!.handleCall(conn, params);
    if (method === RPC_METHODS.toolCancel && this.toolsEnabled) return this.opts.tools!.handleCancel(conn, params);
    if (method === RPC_METHODS.githubToken) {
      if (this.opts.github && this.opts.enabled !== false) return this.opts.github.handle(conn, params);
      return { ok: false, error: "the GitHub App is not configured on the bot" } satisfies GitHubTokenResult;
    }
    // Not gated on DM_WORKSPACE_ENABLED: it is part of delivering a chat message, not a proxied tool.
    if (method === RPC_METHODS.uploadRead) {
      if (this.opts.uploadRead) return this.opts.uploadRead(conn, params);
      return { ok: false, error: "web uploads are not configured on the bot" } satisfies UploadReadResult;
    }
    if (method !== RPC_METHODS.chatDeliver) throw new MethodNotFoundError(`method not found: ${method}`);
    const p = chatDeliverParams.parse(params);
    if (p.principalId !== conn.principalId || p.principalId !== this.opts.principalId) throw new Error("principal mismatch");
    // Reply first; chat/ack confirms the surface send separately.
    void this.deliver(p);
    return {};
  }

  private onNotification(conn: ConnectionInfo, method: string, params: unknown): void {
    if (method === RPC_METHODS.runsChanged) {
      const parsed = runsChangedParams.safeParse(params);
      if (!parsed.success || parsed.data.principalId !== conn.principalId || parsed.data.principalId !== this.opts.principalId) {
        log.debug({ method }, "dropping a malformed or foreign runs/changed");
        return;
      }
      for (const l of [...this.runListeners]) {
        try {
          l(parsed.data);
        } catch (err) {
          log.warn({ err }, "runs/changed listener threw");
        }
      }
      return;
    }
    if (method !== RPC_METHODS.chatEvent) {
      log.debug({ method }, "ignoring workspace notification");
      return;
    }
    const parsed = chatEventParams.safeParse(params);
    if (!parsed.success) {
      log.warn({ error: parsed.error }, "dropping malformed chat/event");
      return;
    }
    if (parsed.data.principalId !== conn.principalId || parsed.data.principalId !== this.opts.principalId) return;
    this.onEvent(parsed.data);
  }

  /** Sends a delivery to its origin's surface once, then acks it. A failed send is left unacked so the
   *  workspace resends it; pages already sent are recorded and skipped on the resend. */
  async deliver(p: ChatDeliverParams): Promise<void> {
    if (this.delivering.has(p.outboxId)) return;
    this.delivering.add(p.outboxId);
    try {
      if (!this.opts.store.hasSeenOutbox(p.outboxId)) {
        this.onAuthDelivery(p);
        const toolCount = p.kind === "reply" && p.turnId ? this.closeTurnForReply(p.turnId) : null;
        const { adapter, origin } = this.surfaceFor(p.origin);
        if (p.kind === "session" && p.session) {
          await adapter.sessionChanged?.(origin, p.session, { outboxId: p.outboxId, plain: false, ledger: { isSent: () => false, markSent: () => {} } });
          this.opts.store.markOutboxSeen(p.outboxId, p.principalId, this.now());
          await this.ackDelivery(p.outboxId);
          return;
        }
        const delivery = deliveryView(p, toolCount);
        if (delivery.type === "ask" && delivery.view.askId !== null && delivery.view.choices.length) {
          this.askChoices.set(delivery.view.askId, delivery.view.choices);
          if (!adapter.capabilities.richButtons) this.numberedAsks.set(adapter.surface, { askId: delivery.view.askId, count: delivery.view.choices.length });
        }
        const ledger: PageLedger = {
          isSent: (i) => this.opts.store.hasSeenOutbox(`${p.outboxId}#${i}`),
          markSent: (i) => this.opts.store.markOutboxSeen(`${p.outboxId}#${i}`, p.principalId, this.now()),
        };
        const alert = p.kind === "alert" && p.alert && adapter.alertPrompt ? p.alert : null;
        const send = (plain: boolean) =>
          alert
            ? adapter.alertPrompt!(origin, alert, p.text, { ledger, plain, outboxId: p.outboxId })
            : delivery.type === "ask"
            ? adapter.askPrompt(origin, delivery.view, { ledger, plain, outboxId: p.outboxId })
            : delivery.type === "auth"
              ? adapter.authPrompt(origin, delivery.view, { ledger, plain, outboxId: p.outboxId })
              : adapter.sendReply(origin, delivery.view, { ledger, plain, outboxId: p.outboxId });
        try {
          await send(false);
          this.opts.store.deleteKv(failureKey(p.outboxId));
        } catch (err) {
          if (err instanceof SurfaceUnavailableError) throw err;
          if (err instanceof DeliveryRejectedError) {
            log.warn({ err, outboxId: p.outboxId, surface: adapter.surface }, "the surface refused a delivery; acking it so it isn't resent");
            this.opts.store.deleteKv(failureKey(p.outboxId));
            this.opts.store.markOutboxSeen(p.outboxId, p.principalId, this.now());
            await this.ackDelivery(p.outboxId);
            return;
          }
          // Persisted: the workspace resends mostly after a register, which usually follows a bot restart.
          const failures = Number(this.opts.store.getKv(failureKey(p.outboxId)) ?? "0") + 1;
          this.opts.store.setKv(failureKey(p.outboxId), String(failures));
          if (failures < DELIVERY_MAX_FAILURES) throw err;
          log.warn({ err, outboxId: p.outboxId, failures }, "delivery keeps failing to render; sending it as plain text");
          await send(true);
          this.opts.store.deleteKv(failureKey(p.outboxId));
        }
        this.opts.store.markOutboxSeen(p.outboxId, p.principalId, this.now());
      }
      await this.ackDelivery(p.outboxId);
    } catch (err) {
      log.warn({ err, outboxId: p.outboxId }, "failed to deliver workspace message");
    } finally {
      this.delivering.delete(p.outboxId);
    }
  }

  private async ackDelivery(outboxId: string): Promise<void> {
    await this.request(RPC_METHODS.chatAck, { outboxId }, CONTROL_TIMEOUT_MS).catch((err) =>
      log.warn({ err, outboxId }, "chat/ack failed; the workspace will resend and be re-acked"),
    );
  }

  /** Finalizes the reply's progress view if it is still open; returns the turn's tool count if known. */
  private closeTurnForReply(turnId: string): number | null {
    const turn = this.turns.get(turnId);
    if (turn) {
      this.finishTurn(turn, "done");
      return turn.toolCount;
    }
    const restored = this.interruptedRestored.get(turnId);
    if (restored) {
      // It had finished while the bot was down: the reply proves it wasn't interrupted.
      this.interruptedRestored.delete(turnId);
      void this.queueFinal(restored, "done");
    }
    return this.endedTurns.get(turnId) ?? null;
  }

  // ── Live progress ──────────────────────────────────────────────────────────

  onEvent(p: ChatEventParams): void {
    if (p.agentId !== MAIN_AGENT) {
      this.onSubagentEvent(p);
      return;
    }
    const origin = p.origin ?? null;
    const ev = p.ev;
    switch (ev.type) {
      case "turn_start": {
        // One main turn runs at a time: a restored view ended while the bot was down, and any other one's
        // turn_end was lost.
        for (const turn of [...this.turns.values()]) if (turn.turnId !== p.turnId && (turn.origin?.surface ?? "") === (origin?.surface ?? "") && (turn.origin?.conversationId ?? "") === (origin?.conversationId ?? "")) this.finishTurn(turn, turn.restored ? "interrupted" : "done");
        const turn = this.turnFor(p.turnId, origin);
        const target = this.tryTarget(turn, origin);
        if (!turn.message && target?.adapter.turnStarted) this.openView(turn, () => target.adapter.turnStarted!(target.origin, this.view(turn)));
        return;
      }
      case "model_activity": {
        const turn = this.turns.get(p.turnId);
        if (!turn || turn.text || turn.lines.length || turn.modelActivity === ev.activity) return;
        turn.modelActivity = ev.activity;
        this.touch(turn);
        return;
      }
      case "tool_start":
        this.addToolLine(this.turnFor(p.turnId, origin), { name: ev.name, summary: ev.summary, state: "run", ...(ev.toolCallId ? { id: ev.toolCallId } : {}) });
        return;
      case "tool_end":
        this.endToolLine(this.turns.get(p.turnId), ev.name, ev.ok, undefined, ev.toolCallId);
        return;
      case "turn_end": {
        // A turn this process never saw start has nothing to finalize; the workspace can repeat these at will.
        const turn = this.turns.get(p.turnId);
        if (turn) this.finishTurn(turn, ev.aborted ? "stopped" : "done");
        return;
      }
      case "text_delta": {
        const existing = this.turns.get(p.turnId);
        const target = this.tryTarget(existing, origin);
        if (!target?.adapter.capabilities.streaming) return;
        const turn = existing ?? this.turnFor(p.turnId, origin);
        turn.text += ev.text;
        if (turn.message && target.adapter.progressDelta) {
          const delta = ev.text;
          void this.queueEdit(turn, (adapter, handle) => adapter.progressDelta!(handle, delta, this.view(turn)), false);
        } else this.touch(turn);
        return;
      }
    }
  }

  /** A subagent's tools render nested in the parent turn's view. Its own turn and text events, and
   *  events whose parent turn isn't shown here, are ignored. */
  private onSubagentEvent(p: ChatEventParams): void {
    const turn = this.turns.get(p.turnId);
    if (!turn) {
      log.debug({ agentId: p.agentId, turnId: p.turnId, type: p.ev.type }, "ignoring subagent event without a live parent turn");
      return;
    }
    if (p.ev.type === "tool_start") this.addToolLine(turn, { name: p.ev.name, summary: p.ev.summary, state: "run", agentId: p.agentId, ...(p.ev.toolCallId ? { id: p.ev.toolCallId } : {}) });
    else if (p.ev.type === "tool_end") this.endToolLine(turn, p.ev.name, p.ev.ok, p.agentId, p.ev.toolCallId);
  }

  private addToolLine(turn: TurnProgress, line: ToolLine): void {
    turn.lines.push({ ...line, id: line.id ?? `${turn.turnId}:${turn.toolCount}`, textOffset: turn.text.length });
    turn.toolCount++;
    this.touch(turn);
  }

  /** Opens the turn's view on its first content, or schedules an edit of the open one. */
  private touch(turn: TurnProgress): void {
    if (!turn.message) {
      this.openView(turn, () => this.createView(turn));
    } else {
      this.markDirty(turn);
      this.persistProgress();
    }
  }

  private openView(turn: TurnProgress, create: () => Promise<SurfaceMessageHandle | null>): void {
    turn.lastEditAt = this.now();
    turn.message = create().catch((err) => {
      log.warn({ err }, "failed to send workspace progress message");
      return null;
    });
    turn.chain = turn.message;
    void turn.message.then((m) => {
      turn.messageId = m?.id ?? null;
      if (this.turns.get(turn.turnId) === turn) this.persistProgress();
    });
  }

  private endToolLine(turn: TurnProgress | undefined, name: string, ok: boolean, agentId: string | undefined, toolCallId?: string): void {
    const line = turn?.lines.find((l) => l.name === name && l.agentId === agentId && l.state === "run" && (!toolCallId || l.id === toolCallId));
    if (!turn || !line) return;
    line.state = ok ? "ok" : "err";
    this.markDirty(turn);
    this.persistProgress();
  }

  /** Waits for every queued progress edit; for tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.turns.values()].map((t) => t.chain.catch(() => {})));
  }

  private turnFor(turnId: string, origin: ChatOrigin | null): TurnProgress {
    let turn = this.turns.get(turnId);
    if (!turn) {
      if (this.turns.size >= MAX_OPEN_TURNS) this.finishTurn(this.turns.values().next().value!, "interrupted");
      turn = {
        turnId,
        origin,
        startedAt: this.now(),
        lines: [],
        toolCount: 0,
        text: "",
        message: null,
        messageId: null,
        target: null,
        restored: false,
        chain: Promise.resolve(),
        lastEditAt: 0,
        timer: null,
      };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private view(turn: TurnProgress): ProgressView {
    return { modelActivity: turn.modelActivity, turnId: turn.turnId, startedAt: turn.startedAt, lines: turn.lines, toolCount: turn.toolCount, text: turn.text };
  }

  private async createView(turn: TurnProgress): Promise<SurfaceMessageHandle | null> {
    try {
      const { adapter, origin } = this.targetOf(turn);
      return await adapter.progressCreate(origin, this.view(turn));
    } catch (err) {
      log.warn({ err }, "failed to send workspace progress message");
      return null;
    }
  }

  /** Posts a final state with no view to edit. */
  private async postFinal(origin: ChatOrigin | null, turnId: string, final: ProgressFinal): Promise<void> {
    try {
      const s = this.surfaceFor(origin);
      await s.adapter.progressFinalize(s.origin, null, { ...final, turnId });
    } catch (err) {
      log.warn({ err }, "failed to send workspace progress message");
    }
  }

  private markDirty(turn: TurnProgress): void {
    if (turn.timer !== null) return; // coalesced into the pending edit
    const delay = progressEditDelay({ now: this.now(), startedAt: turn.startedAt, lastEditAt: turn.lastEditAt }, (age) => this.editGap(turn, age));
    if (delay === 0) {
      this.queueUpdate(turn);
      return;
    }
    turn.timer = this.timers.set(() => {
      turn.timer = null;
      if (this.turns.get(turn.turnId) === turn) this.queueUpdate(turn);
    }, delay);
  }

  private editGap(turn: TurnProgress, ageMs: number): number {
    try {
      return this.targetOf(turn).adapter.progressEditGap(ageMs);
    } catch {
      return 0;
    }
  }

  private queueUpdate(turn: TurnProgress): Promise<unknown> {
    return this.queueEdit(turn, (adapter, handle) => adapter.progressUpdate(handle, this.view(turn)));
  }

  private queueFinal(turn: TurnProgress, outcome: TurnOutcome): Promise<unknown> {
    return this.queueEdit(turn, (adapter, handle, origin) =>
      adapter.progressFinalize(origin, handle, { outcome, activityText: turn.text, lines: turn.lines.map((line) => ({ ...line })), summary: { durationMs: this.now() - turn.startedAt, toolCount: turn.toolCount } }),
    );
  }

  private queueEdit(
    turn: TurnProgress,
    apply: (adapter: SurfaceAdapter, handle: SurfaceMessageHandle, origin: ChatOrigin | null) => Promise<unknown>,
    throttled = true,
  ): Promise<unknown> {
    if (throttled) turn.lastEditAt = this.now();
    const message = turn.message;
    turn.chain = turn.chain.then(async () => {
      const handle = await message;
      if (!handle) return;
      try {
        const s = this.targetOf(turn);
        await apply(s.adapter, handle, s.origin);
      } catch (err) {
        log.warn({ err, turnId: turn.turnId }, "failed to edit workspace progress");
      }
    });
    return turn.chain;
  }

  private rememberEnded(turnId: string, toolCount: number | null): void {
    this.endedTurns.delete(turnId);
    this.endedTurns.set(turnId, toolCount);
    if (this.endedTurns.size > ENDED_TURNS_KEPT) this.endedTurns.delete(this.endedTurns.keys().next().value!);
  }

  private finishTurn(turn: TurnProgress, outcome: TurnOutcome): void {
    this.turns.delete(turn.turnId);
    this.rememberEnded(turn.turnId, turn.toolCount);
    if (turn.timer !== null) {
      this.timers.clear(turn.timer);
      turn.timer = null;
    }
    if (turn.message) void this.queueFinal(turn, outcome);
    else if (outcome !== "done") void this.postFinal(turn.origin, turn.turnId, { outcome, summary: { durationMs: this.now() - turn.startedAt, toolCount: 0 } });
    this.persistProgress();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureKey(outboxId: string): string {
  return `workspace:deliver_failures:${outboxId}`;
}
