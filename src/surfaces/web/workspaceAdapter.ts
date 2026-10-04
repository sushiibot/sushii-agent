import type { SessionBoundary } from "../../orchestration/sessionContracts.ts";
import { ID_MAX, jobAlert, webChatOrigin, type ChatOrigin, type DeliverFile, type DeliverJob, type JobAlertWire, type ToolCallResult } from "../../orchestration/contracts.ts";
import { MAX_OPEN_TURNS } from "../../orchestration/workspace/link.ts";
import { realTimers, type Timers } from "../../orchestration/workspace/progress.ts";
import {
  DeliveryRejectedError,
  SurfaceBusyError,
  type AckKind,
  type ApprovalDecision,
  type ApprovalView,
  type AskView,
  type AuthPromptView,
  type InboundMessage,
  type ProgressFinal,
  type ProgressView,
  type ReplyView,
  type RouterNotice,
  type SendAttempt,
  type SurfaceAdapter,
  type SurfaceCapabilities,
  type SurfaceMessageHandle,
  type ToolLine,
} from "../../orchestration/workspace/surface.ts";
import { getLogger } from "../../logger.ts";
import { WEB_SURFACE } from "./actor.ts";
import type { SqliteChatLog } from "./chatLog.ts";
import { isHttpsUrl, MESSAGE_TEXT_MAX, type ApprovalDecision as WireDecision, type TurnView, type UploadRef } from "./events.ts";
import type { WebHomeStore } from "./homeStore.ts";
import type { WebInboundStore } from "./inbound.ts";
import type { Presence } from "./presence.ts";
import type { PushPayload } from "./push.ts";
import { pushFor, type PushEvent } from "./pushRules.ts";

const log = getLogger("web/workspaceAdapter");

export const SNAPSHOT_GAP_MS = 2_000;

// Bounds on what the workspace chooses. Replies match the workspace history's per-item cap, so a verified
// history item never shows less than the transcript has.
export const REPLY_TEXT_MAX = 100_000;
const ASK_CHOICES_MAX = 25;
const AUTH_INSTRUCTIONS_MAX = 4_000;
const ALERT_TEXT_MAX = 4_000;
export const TOOL_SUMMARY_MAX = 200;
/** Live text past this stops streaming; the reply still carries the whole answer. */
export const TURN_TEXT_MAX = 50_000;
const SNAPSHOT_LINES_MAX = 100;
/** Durable appends the workspace can cause, per link: a burst, then a steady rate. */
export const APPEND_BUDGET = { burst: 300, perSec: 1 };

export type WebInbound = InboundMessage;

export interface WebHandle extends SurfaceMessageHandle {
  /** The turnId for a progress view, the nonce for an approval. */
  readonly id: string;
}

/** The slice of DiskUploadStore the chat surface uses. */
export interface WebUploadPort {
  lookup(ids: string[]): Map<string, UploadRef>;
  /** Idempotent per delivery; files over quota are dropped and counted, not thrown. */
  storeDelivery(outboxId: string, files: DeliverFile[]): Promise<{ files: UploadRef[]; dropped: number }>;
  /** `missing` lists ids that are unknown, malformed or deleted; those are not referenced. */
  markReferenced(ids: string[], messageClientId: string): { missing: string[] };
}

export interface WebAdapterDeps {
  log: SqliteChatLog;
  inbound: WebInboundStore;
  presence: Presence;
  /** Absent when push is not configured; every push then counts as reaching no device. */
  push?: { send(p: PushPayload): Promise<{ sent: number }> };
  /** Called with an approval's nonce when its push reached no device. */
  breakGlass?: (nonce: string) => Promise<boolean>;
  /** Without it the surface takes no files, so the workspace's send_file refuses. */
  uploads?: WebUploadPort;
  /** Job-alert streaks and job messages for Home; without it both show in the chat. */
  home?: Pick<WebHomeStore, "applyAlert" | "addMessage" | "hasMessage">;
  now?: () => number;
  timers?: Timers;
  appendBudget?: { burst: number; perSec: number };
}

interface LiveTurn {
  modelActivity?: "waiting" | "thinking";
  turnId: string;
  startedAt: number;
  lines: ToolLine[];
  toolCount: number;
  /** Built from deltas only; never read back from the link's view, whose text may be ahead of the delta. */
  text: string;
  lastSnapshotAt: number;
  snapshotTimer: unknown;
}

export class WebWorkspaceAdapter implements SurfaceAdapter<WebInbound, WebHandle> {
  private readonly replyListeners = new Set<(reply: ReplyView) => void>();
  /** Voice waits for its own persisted reply, matched by replyTo, without consuming chat events. */
  subscribeReply(listener: (reply: ReplyView) => void): () => void {
    this.replyListeners.add(listener);
    return () => { this.replyListeners.delete(listener); };
  }
  readonly surface = WEB_SURFACE;
  readonly capabilities: SurfaceCapabilities;
  private readonly turns = new Map<string, LiveTurn>();
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly budget: TokenBucket;

  constructor(private readonly deps: WebAdapterDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.budget = new TokenBucket(deps.appendBudget ?? APPEND_BUDGET, this.now);
    this.capabilities = { streaming: true, tables: true, richButtons: true, reactions: false, maxMessageChars: 100_000, fileUploads: deps.uploads !== undefined };
  }

  private pushPayload(event: PushEvent): PushPayload {
    const p = pushFor(event);
    const id = this.deps.log.conversationId;
    return id === "main" ? p : { ...p, url: `/chats/${encodeURIComponent(id)}`, tag: `${p.tag}:${id}` };
  }

  private checkOrigin(origin: ChatOrigin | null): void {
    checkOrigin(origin);
    if ((origin?.conversationId ?? "main") !== this.deps.log.conversationId) throw new DeliveryRejectedError("wrong web conversation");
  }

  openTurns(): TurnView[] {
    return [...this.turns.values()].map((t) => this.view(t));
  }

  /** Fires when a finalize leaves no open turn: the chat routes deliver messages queued behind it.
   *  Set once by `createChatRoutes`; never fires while a turn is still open. */
  onTurnsIdle: (() => void) | null = null;

  async ack(message: WebInbound, kind: AckKind): Promise<void> {
    if (kind === "transcribing") return;
    this.deps.log.transaction(() => {
      // The status event is how the client learns the ack — including `queued`.
      this.deps.log.append("status", { clientId: message.id, state: kind }, `${message.id}:${kind}`);
      // A queued message the bot holds durably must stay pending: the turn's end (or a restart's
      // re-drive) routes it then, so marking it routed here would lose it.
      if (kind !== "queued") this.deps.inbound.markRouted(message.id, this.now());
    });
  }

  async notice(message: WebInbound, notice: RouterNotice): Promise<void> {
    // Neither workspaceOffline nor messageRejected took the message. An offline one stays pending for any
    // resend or reconnect; a rejected one waits for the owner's retry. workspaceOffline names no clientId:
    // the client keeps the entry queued, not failed.
    const offline = notice.type === "workspaceOffline";
    const rejected = notice.type === "messageRejected";
    this.deps.log.transaction(() => {
      this.deps.log.append("notice", offline ? notice : { ...notice, clientId: message.id });
      if (rejected) this.deps.inbound.markRejected(message.id);
      else if (!offline) this.deps.inbound.markRouted(message.id, this.now());
    });
  }

  async transcribe(): Promise<string | null> {
    return null;
  }

  /** Web has no in-process fallback agent. */
  async fallbackReply(message: WebInbound): Promise<string | null> {
    await this.notice(message, { type: "workspaceOffline" });
    return null;
  }

  async resetFallback(message: WebInbound): Promise<void> {
    await this.notice(message, { type: "workspaceOffline" });
  }

  // ── Deliveries: each resolves only after its event is committed, which is what lets the link ack ──

  async sendReply(origin: ChatOrigin | null, reply: ReplyView, attempt: SendAttempt): Promise<void> {
    this.checkOrigin(origin);
    const key = outboxKey(attempt);
    // The last plain try goes to the chat, so a failing inbox never keeps a message unseen.
    if (reply.kind === "proactive" && reply.job && this.deps.home && !attempt.plain) return this.fileMessage(key, reply.text, reply.job);
    if (this.deps.log.find(reply.kind, key) || (reply.job && this.deps.home?.hasMessage(key))) return;
    this.spend();
    const { files, dropped } = await this.storeFiles(reply.files ?? [], key);
    const body = capText(reply.text, REPLY_TEXT_MAX);
    const text = dropped.length ? `${body}\n\n${dropped.map((d) => `[file dropped: ${d}]`).join("\n")}` : body;
    const turnId = reply.turnId && reply.turnId.length <= ID_MAX ? reply.turnId : undefined;
    const data = { key, text, files, ...(turnId ? { turnId } : {}), ...(reply.usage ? { usage: reply.usage } : {}) };
    const anchor = turnId ? this.deps.log.turnAnchor(turnId) : null;
    const { seq, created } = this.deps.log.appendResult(reply.kind, data, key, anchor ?? undefined);
    if (created) {
      void this.notify(seq, { kind: reply.kind, text });
      for (const listener of this.replyListeners) {
        try { listener({ ...reply, text }); } catch (err) { log.warn({ err }, "reply listener failed"); }
      }
    }
  }

  /** A job's message goes to Home's inbox instead of the chat; the agent's own session still has a note of it. */
  private async fileMessage(key: string, text: string, job: DeliverJob): Promise<void> {
    const home = this.deps.home!;
    // A resend of one filed before Home was turned on stays where it went.
    if (home.hasMessage(key) || this.deps.log.find("proactive", key)) return;
    this.spend();
    const shown = capText(text, REPLY_TEXT_MAX);
    if (!home.addMessage({ key, job: job.name, ...(job.runId ? { runId: job.runId } : {}), text: shown })) return;
    this.deps.log.publish({ type: "inbox", data: { key } });
    void this.notify(this.deps.log.head() + 1, { kind: "inbox", key, text: shown });
  }

  /** An askId is unique among stored asks, since the answer route finds the ask by it. A reused or
   *  oversized one is stored without it: the question shows, with no buttons to answer. */
  async askPrompt(origin: ChatOrigin | null, ask: AskView, attempt: SendAttempt): Promise<void> {
    this.checkOrigin(origin);
    const key = outboxKey(attempt);
    if (this.deps.log.find("ask", key)) return;
    this.spend();
    const { seq, created, askId } = this.deps.log.transaction(() => {
      let askId = ask.askId && ask.askId.length <= ID_MAX ? ask.askId : "";
      const taken = askId ? this.deps.log.findAsk(askId) : null;
      if (taken && taken.key !== key) {
        log.warn({ outboxId: key, earlier: taken.key }, "an ask reuses an earlier ask's id; showing it without answer buttons");
        askId = "";
      }
      const choices = askId ? ask.choices.slice(0, ASK_CHOICES_MAX).map((c) => capText(c, ID_MAX)) : [];
      return { ...this.deps.log.appendResult("ask", { key, askId, question: capText(ask.question, MESSAGE_TEXT_MAX), choices, ...(ask.toolConfirmation ? { toolConfirmation: { tool: capText(ask.toolConfirmation.tool, ID_MAX), input: capText(ask.toolConfirmation.input, MESSAGE_TEXT_MAX), ...(ask.toolConfirmation.reason ? { reason: capText(ask.toolConfirmation.reason, 1000) } : {}), ...(ask.toolConfirmation.toolCallId ? { toolCallId: capText(ask.toolConfirmation.toolCallId, ID_MAX) } : {}) } } : {}) }, key), askId };
    });
    if (created) void this.notify(seq, { kind: "ask", askId, question: ask.question });
  }

  async authPrompt(origin: ChatOrigin | null, view: AuthPromptView, attempt: SendAttempt): Promise<void> {
    this.checkOrigin(origin);
    const key = outboxKey(attempt);
    if (this.deps.log.find("auth", key) || this.deps.log.find("proactive", key)) return;
    this.spend();
    const instructions = capText(view.instructions, AUTH_INSTRUCTIONS_MAX);
    if (!isHttpsUrl(view.url)) {
      // contracts.ts already refuses these; a link that gets here anyway is shown as text only.
      log.warn({ outboxId: key }, "sign-in link is not https; delivering its instructions without it");
      this.deps.log.append("proactive", { key, text: instructions, files: [] }, key);
      return;
    }
    const { seq, created } = this.deps.log.appendResult("auth", { key, url: view.url, instructions }, key);
    if (created) void this.notify(seq, { kind: "auth" });
  }

  /** The alert event, its web_alerts row and any alert_cleared commit together, before the link acks. */
  async alertPrompt(origin: ChatOrigin | null, wire: JobAlertWire, text: string, attempt: SendAttempt): Promise<void> {
    this.checkOrigin(origin);
    const key = outboxKey(attempt);
    if (this.deps.log.find("alert", key)) return;
    // The link parsed it already; parsed again here so every field is within its cap before storage and push.
    const parsed = jobAlert.safeParse(wire);
    if (!parsed.success) throw new DeliveryRejectedError("a job alert outside the contract");
    const alert = parsed.data;
    this.spend();
    const shown = capText(text, ALERT_TEXT_MAX);
    const { seq, created, change } = this.deps.log.transaction(() => {
      const res = this.deps.log.appendResult("alert", { key, alert, text: shown }, key);
      const change = res.created ? (this.deps.home?.applyAlert(alert, res.seq, key) ?? "noop") : "noop";
      if (change === "cleared") this.deps.log.append("alert_cleared", { id: `job:${alert.job}`, reason: "recovered" }, `recovered:${key}`);
      return { ...res, change };
    });
    // A stale alert is about a run older than one already reported: it stays in the chat, silently.
    if (!created || change === "stale") return;
    if (alert.kind !== "recovered") void this.notify(seq, { kind: "alert", alert: { job: alert.job, kind: alert.kind, ...(alert.error ? { error: alert.error } : {}) } });
    else if (change === "cleared") void this.notify(seq, { kind: "alertRecovered", job: alert.job });
  }

  async sessionChanged(origin: ChatOrigin | null, boundary: SessionBoundary, attempt: SendAttempt): Promise<void> {
    this.checkOrigin(origin);
    this.deps.log.append("session", boundary, outboxKey(attempt));
  }

  progressEditGap(): number {
    return 0;
  }

  async progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<WebHandle> {
    this.checkOrigin(origin);
    const turn = this.track({ turnId: view.turnId, startedAt: view.startedAt, lines: [], toolCount: 0, text: view.text.slice(0, TURN_TEXT_MAX), lastSnapshotAt: 0, snapshotTimer: null });
    this.applyLines(turn, view);
    this.snapshot(turn);
    return { id: view.turnId };
  }

  /** The working bubble and Stop show at once, and the turn's reply sorts from here in history. */
  turnStarted(origin: ChatOrigin | null, view: ProgressView): Promise<WebHandle> {
    return this.progressCreate(origin, view);
  }

  async progressUpdate(handle: WebHandle, view: ProgressView): Promise<void> {
    const turn = this.turnOf(handle, view);
    this.applyLines(turn, view);
    this.scheduleSnapshot(turn);
  }

  async progressDelta(handle: WebHandle, delta: string, view: ProgressView): Promise<void> {
    const turn = this.turnOf(handle, view);
    const offset = turn.text.length;
    const text = delta.slice(0, TURN_TEXT_MAX - offset);
    if (!text) return;
    turn.text += text;
    this.deps.log.publish({ type: "delta", data: { turnId: turn.turnId, offset, text } });
    this.scheduleSnapshot(turn);
  }

  async progressFinalize(origin: ChatOrigin | null, handle: WebHandle | null, final: ProgressFinal): Promise<void> {
    this.checkOrigin(origin);
    const turnId = handle?.id ?? final.turnId ?? "";
    if (!turnId || turnId.length > ID_MAX) {
      log.warn({ outcome: final.outcome }, "dropping a turn final with no usable turnId");
      return;
    }
    this.finalize(turnId, final);
  }

  /** A view from before a restart comes back empty; the next snapshot and the final reply fill it in. */
  async progressReopen(origin: ChatOrigin | null, id: string): Promise<WebHandle | null> {
    this.checkOrigin(origin);
    if (!this.turns.has(id)) this.track({ turnId: id, startedAt: this.now(), lines: [], toolCount: 0, text: "", lastSnapshotAt: 0, snapshotTimer: null });
    return { id };
  }

  // The only source of approval events.

  async approvalPrompt(origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<WebHandle> {
    this.checkOrigin(origin);
    const { replyCode: _code, ...shown } = view;
    const { seq, created } = this.deps.log.appendResult("approval", { nonce, view: shown }, nonce);
    if (created) void this.notifyApproval(seq, nonce, view.tool);
    return { id: nonce };
  }

  async resolveApproval(_handle: WebHandle, _view: ApprovalView, nonce: string, decision: ApprovalDecision, result?: ToolCallResult): Promise<void> {
    const wire: WireDecision = decision === "expired" ? "timeout" : decision;
    // An approve resolves twice, once when the tool starts and again with its result.
    this.deps.log.append("approval_resolved", { nonce, decision: wire, ...(result ? { result } : {}) }, result ? `${nonce}:result` : nonce);
  }

  /** Not a chat event, so it takes the next seq: only a receipt for something newer suppresses it. */
  async notifyPhotoQuota(usedBytes: number, capBytes: number): Promise<void> {
    await this.notify(this.deps.log.head() + 1, { kind: "quota", usedBytes, capBytes });
  }

  close(): void {
    for (const t of this.turns.values()) this.timers.clear(t.snapshotTimer);
  }

  private finalize(turnId: string, final: ProgressFinal): void {
    const turn = this.turns.get(turnId);
    if (turn) this.timers.clear(turn.snapshotTimer);
    this.turns.delete(turnId);
    try {
      const key = `${turnId}:${final.outcome}`;
      if (this.deps.log.find("turn_final", key)) return;
      if (!this.budget.take()) {
        log.warn({ outcome: final.outcome }, "dropping a turn final over the workspace's append budget");
        return;
      }
      // One key per outcome, so a turn marked interrupted after a restart can still be marked done by its reply.
      const { seq, created } = this.deps.log.appendResult("turn_final", { turnId, outcome: final.outcome, summary: final.summary, activityText: capText(final.activityText ?? turn?.text ?? "", TURN_TEXT_MAX), lines: [...(final.lines ?? turn?.lines ?? [])].map((line) => ({ ...line, name: capText(line.name, ID_MAX), summary: capText(line.summary, TOOL_SUMMARY_MAX) })) }, key);
      if (created && final.outcome === "interrupted") void this.notify(seq, { kind: "interrupted" });
    } finally {
      // The last open turn ended: this is when a message queued behind it is delivered, in order.
      if (this.turns.size === 0) this.onTurnsIdle?.();
    }
  }

  /** Adds a live turn; past the cap the oldest is finalized as interrupted, so `hello` stays bounded. */
  private track(turn: LiveTurn): LiveTurn {
    this.turns.delete(turn.turnId);
    this.deps.log.anchorTurn(turn.turnId);
    while (this.turns.size >= MAX_OPEN_TURNS) {
      const oldest = this.turns.values().next().value!;
      this.finalize(oldest.turnId, { outcome: "interrupted", summary: null });
    }
    this.turns.set(turn.turnId, turn);
    return turn;
  }

  private turnOf(handle: WebHandle, view: ProgressView): LiveTurn {
    return this.turns.get(handle.id) ?? this.track({ turnId: handle.id, startedAt: view.startedAt, lines: [], toolCount: 0, text: "", lastSnapshotAt: 0, snapshotTimer: null });
  }

  private applyLines(turn: LiveTurn, view: ProgressView): void {
    const lines = view.lines.map((l) => ({ ...l, name: capText(l.name, ID_MAX), summary: capText(l.summary, TOOL_SUMMARY_MAX) }));
    lines.forEach((line, i) => {
      const prev = turn.lines[i];
      if (prev && prev.state === line.state) return;
      this.deps.log.publish({
        type: "tool",
        data: { turnId: turn.turnId, name: line.name, summary: line.summary, ...(line.id ? { id: line.id } : {}), ...(line.textOffset !== undefined ? { textOffset: line.textOffset } : {}), ...(line.agentId ? { agentId: line.agentId } : {}), ...(line.state !== "run" ? { ok: line.state === "ok" } : {}) },
      });
    });
    turn.modelActivity = view.modelActivity;
    turn.lines = lines;
    turn.toolCount = view.toolCount;
  }

  private view(turn: LiveTurn): ProgressView {
    return { modelActivity: turn.modelActivity, turnId: turn.turnId, startedAt: turn.startedAt, lines: turn.lines.slice(-SNAPSHOT_LINES_MAX).map((l) => ({ ...l })), toolCount: turn.toolCount, text: turn.text };
  }

  /** Over budget, a delivery stays unacked without counting a failure; the workspace resends it later. */
  private spend(): void {
    if (!this.budget.take()) throw new SurfaceBusyError("the web chat is over the workspace's append budget");
  }

  private snapshot(turn: LiveTurn): void {
    turn.lastSnapshotAt = this.now();
    this.deps.log.publish({ type: "snapshot", data: { turnId: turn.turnId, view: this.view(turn) } });
  }

  private scheduleSnapshot(turn: LiveTurn): void {
    if (turn.snapshotTimer !== null) return;
    const wait = Math.max(0, turn.lastSnapshotAt + SNAPSHOT_GAP_MS - this.now());
    turn.snapshotTimer = this.timers.set(() => {
      turn.snapshotTimer = null;
      if (this.turns.get(turn.turnId) === turn) this.snapshot(turn);
    }, wait);
  }

  /** A store failure other than quota throws, leaving the delivery unacked for the workspace to resend. */
  private async storeFiles(files: DeliverFile[], outboxId: string): Promise<{ files: UploadRef[]; dropped: string[] }> {
    if (!files.length) return { files: [], dropped: [] };
    if (!this.deps.uploads) return { files: [], dropped: files.map(() => "storage unavailable") };
    const res = await this.deps.uploads.storeDelivery(outboxId, files);
    return { files: res.files, dropped: Array.from({ length: res.dropped }, () => "quota") };
  }

  /** Pushes unless a seen receipt for `seq` arrives first. Resolves to the devices reached, null when suppressed. */
  private async notify(seq: number, event: PushEvent): Promise<number | null> {
    try {
      if (!(await this.deps.presence.shouldPush(seq))) return null;
      if (!this.deps.push) return 0;
      return (await this.deps.push.send(this.pushPayload(event))).sent;
    } catch (err) {
      log.warn({ err }, "web push failed");
      return 0;
    }
  }

  private async notifyApproval(seq: number, nonce: string, tool: string): Promise<void> {
    const sent = await this.notify(seq, { kind: "approval", nonce, tool });
    if (sent !== 0 || !this.deps.breakGlass) return;
    await this.deps.breakGlass(nonce).catch((err) => log.warn({ err }, "break-glass DM failed"));
  }
}

/** The web surface has one conversation. A workspace-chosen origin naming anything else is refused. */
function checkOrigin(origin: ChatOrigin | null): void {
  if (origin !== null && !webChatOrigin.safeParse(origin).success) throw new DeliveryRejectedError("web origin must be the main conversation");
}

function outboxKey(attempt: SendAttempt): string {
  if (!attempt.outboxId) throw new Error("a web delivery needs its outbox id");
  if (attempt.outboxId.length > ID_MAX) throw new DeliveryRejectedError("a web delivery's outbox id is too long");
  return attempt.outboxId;
}

export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters]` : text;
}

class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate: { burst: number; perSec: number },
    private readonly now: () => number,
  ) {
    this.tokens = rate.burst;
    this.at = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.rate.burst, this.tokens + ((t - this.at) / 1000) * this.rate.perSec);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}
