import { webChatOrigin, type ChatOrigin, type DeliverFile, type ToolCallResult } from "../../orchestration/contracts.ts";
import { realTimers, type Timers } from "../../orchestration/workspace/progress.ts";
import type {
  AckKind,
  ApprovalDecision,
  ApprovalView,
  AskView,
  AuthPromptView,
  InboundMessage,
  ProgressFinal,
  ProgressView,
  ReplyView,
  RouterNotice,
  SendAttempt,
  SurfaceAdapter,
  SurfaceCapabilities,
  SurfaceMessageHandle,
  ToolLine,
} from "../../orchestration/workspace/surface.ts";
import { getLogger } from "../../logger.ts";
import { WEB_SURFACE } from "./actor.ts";
import type { SqliteChatLog } from "./chatLog.ts";
import { isHttpsUrl, type ApprovalDecision as WireDecision, type TurnView, type UploadRef } from "./events.ts";
import type { WebInboundStore } from "./inbound.ts";
import type { Presence } from "./presence.ts";
import type { PushPayload } from "./push.ts";

const log = getLogger("web/workspaceAdapter");

export const SNAPSHOT_GAP_MS = 2_000;
const PUSH_BODY_MAX = 140;

export type WebInbound = InboundMessage;

export interface WebHandle extends SurfaceMessageHandle {
  /** The turnId for a progress view, the nonce for an approval. */
  readonly id: string;
}

/** The slice of DiskUploadStore the chat surface uses. */
export interface WebUploadPort {
  lookup(ids: string[]): Map<string, UploadRef>;
  forOutbox(outboxIds: string[]): Map<string, UploadRef[]>;
  /** Idempotent per delivery; files over quota are dropped and counted, not thrown. */
  storeDelivery(outboxId: string, files: DeliverFile[]): Promise<{ files: UploadRef[]; dropped: number }>;
  markReferenced(ids: string[], messageClientId: string): void;
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

  constructor(private readonly deps: WebAdapterDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
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
    this.deps.log.transaction(() => {
      this.deps.log.append("notice", notice);
      // workspaceOffline means nothing was taken: the client resends the same clientId later.
      if (notice.type !== "workspaceOffline") this.deps.inbound.markRouted(message.id, this.now());
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
    const { files, dropped } = await this.storeFiles(reply.files ?? [], key);
    const text = dropped.length ? `${reply.text}\n\n${dropped.map((d) => `[file dropped: ${d}]`).join("\n")}` : reply.text;
    const data = { key, text, files, ...(reply.turnId ? { turnId: reply.turnId } : {}), ...(reply.usage ? { usage: reply.usage } : {}) };
    const { seq, created } = this.deps.log.appendResult(reply.kind, data, key);
    if (created) void this.notify(seq, { title: "sushii-agent", body: pushBody(text) || "Sent a file", url: "/", tag: "chat" });
  }

  async askPrompt(origin: ChatOrigin | null, ask: AskView, attempt: SendAttempt): Promise<void> {
    checkOrigin(origin);
    const key = outboxKey(attempt);
    const askId = ask.askId ?? "";
    const { seq, created } = this.deps.log.appendResult("ask", { key, askId, question: ask.question, choices: askId ? ask.choices : [] }, key);
    if (created) {
      const url = askId ? `/?ask=${encodeURIComponent(askId)}` : "/";
      void this.notify(seq, { title: "The agent asks", body: pushBody(ask.question), url, tag: askId ? `ask:${askId}` : "chat" });
    }
  }

  async authPrompt(origin: ChatOrigin | null, view: AuthPromptView, attempt: SendAttempt): Promise<void> {
    checkOrigin(origin);
    const key = outboxKey(attempt);
    if (!isHttpsUrl(view.url)) {
      // contracts.ts already refuses these; a link that gets here anyway is shown as text only.
      log.warn({ outboxId: key }, "sign-in link is not https; delivering its instructions without it");
      this.deps.log.append("proactive", { key, text: view.instructions, files: [] }, key);
      return;
    }
    const { seq, created } = this.deps.log.appendResult("auth", { key, url: view.url, instructions: view.instructions }, key);
    if (created) void this.notify(seq, { title: "sushii-agent", body: "Sign-in link ready", url: "/", tag: "auth" });
  }

  progressEditGap(): number {
    return 0;
  }

  async progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<WebHandle> {
    checkOrigin(origin);
    const turn: LiveTurn = { turnId: view.turnId, startedAt: view.startedAt, lines: [], toolCount: 0, text: view.text, lastSnapshotAt: 0, snapshotTimer: null };
    this.turns.set(view.turnId, turn);
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
    turn.text += delta;
    this.deps.log.publish({ type: "delta", data: { turnId: turn.turnId, offset, text: delta } });
    this.scheduleSnapshot(turn);
  }

  async progressFinalize(origin: ChatOrigin | null, handle: WebHandle | null, final: ProgressFinal): Promise<void> {
    const turnId = handle?.id ?? "";
    const turn = this.turns.get(turnId);
    if (turn) this.timers.clear(turn.snapshotTimer);
    this.turns.delete(turnId);
    const data = { turnId, outcome: final.outcome, summary: final.summary };
    // One key per outcome, so a turn marked interrupted after a restart can still be marked done by its reply.
    const { seq, created } = this.deps.log.appendResult("turn_final", data, turnId ? `${turnId}:${final.outcome}` : undefined);
    if (created && final.outcome === "interrupted") void this.notify(seq, { title: "sushii-agent", body: "Turn interrupted", url: "/", tag: "chat" });
  }

  /** A view from before a restart comes back empty; the next snapshot and the final reply fill it in. */
  async progressReopen(_origin: ChatOrigin | null, id: string): Promise<WebHandle | null> {
    if (!this.turns.has(id)) this.turns.set(id, { turnId: id, startedAt: this.now(), lines: [], toolCount: 0, text: "", lastSnapshotAt: 0, snapshotTimer: null });
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

  private turnOf(handle: WebHandle, view: ProgressView): LiveTurn {
    let turn = this.turns.get(handle.id);
    if (!turn) {
      turn = { turnId: handle.id, startedAt: view.startedAt, lines: [], toolCount: 0, text: "", lastSnapshotAt: 0, snapshotTimer: null };
      this.turns.set(handle.id, turn);
    }
    return turn;
  }

  private applyLines(turn: LiveTurn, view: ProgressView): void {
    view.lines.forEach((line, i) => {
      const prev = turn.lines[i];
      if (prev && prev.state === line.state) return;
      this.deps.log.publish({
        type: "tool",
        data: { turnId: turn.turnId, name: line.name, summary: line.summary, ...(line.state !== "run" ? { ok: line.state === "ok" } : {}) },
      });
    });
    turn.lines = view.lines.map((l) => ({ ...l }));
    turn.toolCount = view.toolCount;
  }

  private view(turn: LiveTurn): ProgressView {
    return { turnId: turn.turnId, startedAt: turn.startedAt, lines: turn.lines.map((l) => ({ ...l })), toolCount: turn.toolCount, text: turn.text };
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
  if (origin !== null && !webChatOrigin.safeParse(origin).success) throw new Error("web origin must be the main conversation");
}

function outboxKey(attempt: SendAttempt): string {
  if (!attempt.outboxId) throw new Error("a web delivery needs its outbox id");
  return attempt.outboxId;
}

function pushBody(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > PUSH_BODY_MAX ? `${plain.slice(0, PUSH_BODY_MAX - 1)}…` : plain;
}
