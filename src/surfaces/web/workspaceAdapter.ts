import { ID_MAX, webChatOrigin, type ChatOrigin, type DeliverFile, type ToolCallResult } from "../../orchestration/contracts.ts";
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
import type { WebInboundStore } from "./inbound.ts";
import type { Presence } from "./presence.ts";
import type { PushPayload } from "./push.ts";

const log = getLogger("web/workspaceAdapter");

export const SNAPSHOT_GAP_MS = 2_000;
const PUSH_BODY_MAX = 140;

// Bounds on what the workspace chooses. Replies match the workspace history's per-item cap, so a verified
// history item never shows less than the transcript has.
export const REPLY_TEXT_MAX = 100_000;
const ASK_CHOICES_MAX = 25;
const AUTH_INSTRUCTIONS_MAX = 4_000;
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
  now?: () => number;
  timers?: Timers;
  appendBudget?: { burst: number; perSec: number };
}

interface LiveTurn {
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

  openTurns(): TurnView[] {
    return [...this.turns.values()].map((t) => this.view(t));
  }

  async ack(message: WebInbound, kind: AckKind): Promise<void> {
    if (kind === "transcribing") return;
    this.deps.log.transaction(() => {
      this.deps.log.append("status", { clientId: message.id, state: kind }, `${message.id}:${kind}`);
      this.deps.inbound.markRouted(message.id, this.now());
    });
  }

  async notice(message: WebInbound, notice: RouterNotice): Promise<void> {
    // workspaceOffline means nothing was taken: the client resends the same clientId later, so the notice
    // must not name it (a notice with a clientId clears the client's outbox entry).
    const consumed = notice.type !== "workspaceOffline";
    this.deps.log.transaction(() => {
      this.deps.log.append("notice", consumed ? { ...notice, clientId: message.id } : notice);
      if (consumed) this.deps.inbound.markRouted(message.id, this.now());
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
    checkOrigin(origin);
    const key = outboxKey(attempt);
    if (this.deps.log.find(reply.kind, key)) return;
    this.spend();
    const { files, dropped } = await this.storeFiles(reply.files ?? [], key);
    const body = capText(reply.text, REPLY_TEXT_MAX);
    const text = dropped.length ? `${body}\n\n${dropped.map((d) => `[file dropped: ${d}]`).join("\n")}` : body;
    const turnId = reply.turnId && reply.turnId.length <= ID_MAX ? reply.turnId : undefined;
    const data = { key, text, files, ...(turnId ? { turnId } : {}), ...(reply.usage ? { usage: reply.usage } : {}) };
    const { seq, created } = this.deps.log.appendResult(reply.kind, data, key);
    if (created) void this.notify(seq, { title: "sushii-agent", body: pushBody(text) || "Sent a file", url: "/", tag: "chat" });
  }

  /** An askId is unique among stored asks, since the answer route finds the ask by it. A reused or
   *  oversized one is stored without it: the question shows, with no buttons to answer. */
  async askPrompt(origin: ChatOrigin | null, ask: AskView, attempt: SendAttempt): Promise<void> {
    checkOrigin(origin);
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
      return { ...this.deps.log.appendResult("ask", { key, askId, question: capText(ask.question, MESSAGE_TEXT_MAX), choices }, key), askId };
    });
    if (created) {
      const url = askId ? `/?ask=${encodeURIComponent(askId)}` : "/";
      void this.notify(seq, { title: "The agent asks", body: pushBody(ask.question), url, tag: askId ? `ask:${askId}` : "chat" });
    }
  }

  async authPrompt(origin: ChatOrigin | null, view: AuthPromptView, attempt: SendAttempt): Promise<void> {
    checkOrigin(origin);
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
    if (created) void this.notify(seq, { title: "sushii-agent", body: "Sign-in link ready", url: "/", tag: "auth" });
  }

  progressEditGap(): number {
    return 0;
  }

  async progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<WebHandle> {
    checkOrigin(origin);
    const turn = this.track({ turnId: view.turnId, startedAt: view.startedAt, lines: [], toolCount: 0, text: view.text.slice(0, TURN_TEXT_MAX), lastSnapshotAt: 0, snapshotTimer: null });
    this.applyLines(turn, view);
    this.snapshot(turn);
    return { id: view.turnId };
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

  async progressFinalize(_origin: ChatOrigin | null, handle: WebHandle | null, final: ProgressFinal): Promise<void> {
    const turnId = handle?.id ?? final.turnId ?? "";
    if (!turnId || turnId.length > ID_MAX) {
      log.warn({ outcome: final.outcome }, "dropping a turn final with no usable turnId");
      return;
    }
    this.finalize(turnId, final);
  }

  /** A view from before a restart comes back empty; the next snapshot and the final reply fill it in. */
  async progressReopen(_origin: ChatOrigin | null, id: string): Promise<WebHandle | null> {
    if (!this.turns.has(id)) this.track({ turnId: id, startedAt: this.now(), lines: [], toolCount: 0, text: "", lastSnapshotAt: 0, snapshotTimer: null });
    return { id };
  }

  // The only source of approval events.

  async approvalPrompt(_origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<WebHandle> {
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

  close(): void {
    for (const t of this.turns.values()) this.timers.clear(t.snapshotTimer);
  }

  private finalize(turnId: string, final: ProgressFinal): void {
    const turn = this.turns.get(turnId);
    if (turn) this.timers.clear(turn.snapshotTimer);
    this.turns.delete(turnId);
    const key = `${turnId}:${final.outcome}`;
    if (this.deps.log.find("turn_final", key)) return;
    if (!this.budget.take()) {
      log.warn({ outcome: final.outcome }, "dropping a turn final over the workspace's append budget");
      return;
    }
    // One key per outcome, so a turn marked interrupted after a restart can still be marked done by its reply.
    const { seq, created } = this.deps.log.appendResult("turn_final", { turnId, outcome: final.outcome, summary: final.summary }, key);
    if (created && final.outcome === "interrupted") void this.notify(seq, { title: "sushii-agent", body: "Turn interrupted", url: "/", tag: "chat" });
  }

  /** Adds a live turn; past the cap the oldest is finalized as interrupted, so `hello` stays bounded. */
  private track(turn: LiveTurn): LiveTurn {
    this.turns.delete(turn.turnId);
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
        data: { turnId: turn.turnId, name: line.name, summary: line.summary, ...(line.state !== "run" ? { ok: line.state === "ok" } : {}) },
      });
    });
    turn.lines = lines;
    turn.toolCount = view.toolCount;
  }

  private view(turn: LiveTurn): ProgressView {
    return { turnId: turn.turnId, startedAt: turn.startedAt, lines: turn.lines.slice(-SNAPSHOT_LINES_MAX).map((l) => ({ ...l })), toolCount: turn.toolCount, text: turn.text };
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
  private async notify(seq: number, payload: PushPayload): Promise<number | null> {
    try {
      if (!(await this.deps.presence.shouldPush(seq))) return null;
      if (!this.deps.push) return 0;
      return (await this.deps.push.send(payload)).sent;
    } catch (err) {
      log.warn({ err }, "web push failed");
      return 0;
    }
  }

  private async notifyApproval(seq: number, nonce: string, tool: string): Promise<void> {
    const sent = await this.notify(seq, { title: "Approval needed", body: `sushii-agent needs your approval to run ${tool}`, url: "/", tag: `approval:${nonce}` });
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

function pushBody(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > PUSH_BODY_MAX ? `${plain.slice(0, PUSH_BODY_MAX - 1)}…` : plain;
}
