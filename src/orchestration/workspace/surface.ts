import type { ChatOrigin, ChatUsage, DeliverFile, DeliverJob, JobAlertWire, ToolCallResult } from "../contracts.ts";

/** What a chat surface can render. The core consults these instead of assuming Discord's feature set. */
export interface SurfaceCapabilities {
  /** Shows a turn's text as it streams. Without it, `text_delta` events are dropped and only the reply shows. */
  streaming: boolean;
  /** Renders markdown tables. */
  tables: boolean;
  /** Interactive buttons (Stop, ask choices, Approve/Deny). */
  richButtons: boolean;
  /** Emoji reactions on the user's own message. */
  reactions: boolean;
  /** Longest single message; longer replies are paged by the adapter. */
  maxMessageChars: number;
  /** Uploads the files a reply carries. Without it the workspace's send_file refuses. */
  fileUploads?: boolean;
}

/** One tool in a turn's progress view. `agentId` is set for a subagent's tool, shown nested under the turn. */
export type ToolLine = { name: string; summary: string; state: "run" | "ok" | "err"; agentId?: string };

export interface ProgressView {
  turnId: string;
  startedAt: number;
  /** Every tool line of the turn, oldest first; the adapter decides how many to show. */
  lines: readonly ToolLine[];
  toolCount: number;
  /** Text streamed so far; always empty on a surface without `streaming`. */
  text: string;
}

export type TurnOutcome = "done" | "stopped" | "interrupted";

export interface ProgressFinal {
  outcome: TurnOutcome;
  /** Null for a turn this process no longer tracks (it outlived a restart). */
  summary: { durationMs: number; toolCount: number } | null;
  /** The turn a final without a handle belongs to. */
  turnId?: string;
}

/** A surface's handle on a message it can edit later. `id` lets the view be found again after a restart. */
export interface SurfaceMessageHandle {
  readonly id?: string;
}

export interface ReplyView {
  kind: "reply" | "proactive";
  text: string;
  usage?: ChatUsage;
  /** Tools the answered turn ran, when known. */
  toolCount: number | null;
  turnId?: string;
  replyTo?: string;
  /** Files to attach; only sent to a surface with `fileUploads`. */
  files?: DeliverFile[];
  /** On a proactive message: the scheduled job that sent it. */
  job?: DeliverJob;
}

export interface AskView {
  /** Null when the workspace sent a bare ask with no id: nothing to answer by button. */
  askId: string | null;
  question: string;
  /** Non-blank labels, in the workspace's order. */
  choices: string[];
}

/** A sign-in link for the principal to open; the result arrives later as an ordinary reply. */
export interface AuthPromptView {
  url: string;
  instructions: string;
}

/** Which pages of a multi-page delivery already went out, so a resend skips them. */
export interface PageLedger {
  isSent(page: number): boolean;
  markSent(page: number): void;
}

export interface SendAttempt {
  ledger: PageLedger;
  /** Last resort after repeated failures: send the unsent text as plain messages, no rich rendering. */
  plain: boolean;
  /** The delivery's workspace outbox id, for a surface that stores deliveries idempotently. */
  outboxId?: string;
}

/** One validated argument on an approval prompt, in the tool's fixed display order. A `single` value is
 *  at most `max` chars and shown whole on one line; a `body` is shown as a block, and any clipping to fit
 *  the surface is the adapter's call. */
export type ApprovalField = { key: string; value: string; kind: "single"; max: number } | { key: string; value: string; kind: "body" };

export interface ApprovalView {
  tool: string;
  /** Self-reported by the workspace, so advisory. */
  agentId: string;
  agentName: string;
  fields: ApprovalField[];
  /** Set only on a surface without `richButtons`: the owner answers `approve <code>` or `deny <code>`. */
  replyCode?: string;
}

/** `cancelled`: the workspace withdrew the call because its turn was stopped. */
export type ApprovalDecision = "approve" | "deny" | "timeout" | "expired" | "cancelled";

/** Receipt signals on the user's message. */
export type AckKind = "accepted" | "steer" | "queued" | "newSession" | "stopped" | "transcribing";

/** Who clicked a button or sent a reply, as the surface identifies them. */
export interface SurfaceActor {
  surface: string;
  userId: string;
  name: string;
}

/** Status lines the owner-message router posts in reply to a message. */
export type RouterNotice =
  | { type: "newSessionStarted" }
  | { type: "newSessionFailed"; error: string }
  | { type: "newWhileOffline" }
  | { type: "nothingToStop" }
  | { type: "stopFailed"; error: string }
  | { type: "transcriptionFailed" }
  | { type: "transcript"; text: string }
  | { type: "approvalExpired" }
  | { type: "askAlreadyAnswered" }
  | { type: "askNotDelivered"; error: string }
  | { type: "loginOffline" }
  | { type: "loginAlreadyPending" }
  | { type: "loginNotPending" }
  // A sign-in callback arrived with no login pending; it went nowhere.
  | { type: "loginCallbackIgnored" }
  // The pasted callback can't finish the sign-in (wrong path case, other login's state, truncated); it stays open.
  | { type: "loginCallbackRejected"; error: string }
  | { type: "loginFailed"; error: string }
  | { type: "loginUsage" }
  // A workspace command's (!compact, !model, !tasks) answer, as plain markdown.
  | { type: "commandResult"; text: string }
  | { type: "commandOffline" }
  | { type: "commandFailed"; error: string }
  // The router's `offline: "reject"` mode: nothing was recorded, so the surface resends the same message later.
  | { type: "workspaceOffline" }
  // `reject` mode with the workspace connected: it refused the message, which stays unrouted for a retry.
  | { type: "messageRejected"; error: string };

/** A user's message as the core sees it; adapters extend it with whatever they need to answer it. */
export interface InboundMessage {
  origin: ChatOrigin;
  id: string;
  text: string;
  author: { id: string; name: string };
  isVoice: boolean;
  attachments: Array<{ url: string; name: string; contentType: string }>;
  /** The sender as an owner check sees it. Web sets the actor its gateway minted from the verified login;
   *  without one, the router builds a plain actor from `origin` and `author`. */
  actor?: SurfaceActor;
}

/** The surface an inbound message arrived on, answering that message. */
export interface InboundSurface<M extends InboundMessage = InboundMessage> {
  ack(message: M, kind: AckKind): Promise<void>;
  notice(message: M, notice: RouterNotice): Promise<void>;
  /** Speech-to-text for a voice message; null when it can't be transcribed. */
  transcribe(message: M): Promise<string | null>;
  /** Answers with the in-process agent; resolves to the reply text delivered, if any. `offline` adds the
   *  "workspace offline" notice. */
  fallbackReply(message: M, text: string, opts: { offline: boolean }): Promise<string | null>;
  /** The fallback agent's own "new session": clears its conversation history. */
  resetFallback(message: M): Promise<void>;
}

/**
 * A chat surface the personal-agent workspace talks through. The core passes structured views; all
 * rendering (markup, buttons, paging, ids) stays in the adapter. A null origin means the principal's
 * default conversation on this surface (a proactive message, or a legacy delivery without one).
 * A send that fails because the surface can't reach the principal at all throws SurfaceUnavailableError.
 */
export interface SurfaceAdapter<M extends InboundMessage = InboundMessage, H extends SurfaceMessageHandle = SurfaceMessageHandle> extends InboundSurface<M> {
  readonly surface: string;
  readonly capabilities: SurfaceCapabilities;
  sendReply(origin: ChatOrigin | null, reply: ReplyView, attempt: SendAttempt): Promise<void>;
  /** Without `richButtons`, choices are answered by their number (1-based) in a reply. */
  askPrompt(origin: ChatOrigin | null, ask: AskView, attempt: SendAttempt): Promise<void>;
  /** A sign-in link. With `attempt.plain`, the URL and instructions as plain text. */
  authPrompt(origin: ChatOrigin | null, view: AuthPromptView, attempt: SendAttempt): Promise<void>;
  /** A structured scheduled-job alert. Without it the link sends `text` as a proactive reply. */
  alertPrompt?(origin: ChatOrigin | null, alert: JobAlertWire, text: string, attempt: SendAttempt): Promise<void>;
  /** Minimum gap between progress updates of a turn `ageMs` old; 0 updates on every change. */
  progressEditGap(ageMs: number): number;
  progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<H>;
  /** Opens the turn's view as soon as the turn starts, before any content; the handle becomes the turn's view.
   *  Without it the view opens on the turn's first tool or text. */
  turnStarted?(origin: ChatOrigin | null, view: ProgressView): Promise<H>;
  progressUpdate(handle: H, view: ProgressView): Promise<void>;
  /** A streaming surface's live text: called per delta, unthrottled, instead of a full update. */
  progressDelta?(handle: H, delta: string, view: ProgressView): Promise<void>;
  /** Edits the view into its final state, or posts the final state on its own when there is no view. */
  progressFinalize(origin: ChatOrigin | null, handle: H | null, final: ProgressFinal): Promise<void>;
  /** Re-opens a progress view an earlier process posted; null when it's gone. */
  progressReopen(origin: ChatOrigin | null, id: string): Promise<H | null>;
  approvalPrompt(origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<H>;
  /** Updates a posted prompt: decided, running (approve without result) or finished (with result). */
  resolveApproval(handle: H, view: ApprovalView, nonce: string, decision: ApprovalDecision, result?: ToolCallResult): Promise<void>;
}

/** The surface can't reach the principal at all (not a rendering failure). */
export class SurfaceUnavailableError extends Error {}

/** The surface is shedding load: the delivery stays unacked, without counting a failure, for a later resend. */
export class SurfaceBusyError extends SurfaceUnavailableError {}

/** The surface will never take this delivery, so it is acked and dropped rather than resent forever. */
export class DeliveryRejectedError extends Error {}

export interface ResolvedSurface {
  adapter: SurfaceAdapter;
  /** Null when the target is the principal's default conversation there. */
  origin: ChatOrigin | null;
}

/** Adapters keyed by surface id. Anything without a registered origin goes to the preferred surface.
 *  A pinned registry sends everything to the preferred surface, whatever the origin, and never to another. */
export class SurfaceRegistry {
  private readonly adapters = new Map<string, SurfaceAdapter>();
  private readonly waiters = new Set<() => void>();
  readonly preferredSurface: string;
  readonly pinned: boolean;

  constructor(preferredSurface: string, opts: { pinned?: boolean } = {}) {
    this.preferredSurface = preferredSurface.trim().toLowerCase();
    this.pinned = opts.pinned === true;
  }

  registered(): string[] {
    return [...this.adapters.keys()];
  }

  hasPreferred(): boolean {
    return this.adapters.has(this.preferredSurface);
  }

  /** Adapters may register after boot; a surface that starts late wakes anything waiting for the preferred one. */
  register(adapter: SurfaceAdapter): this {
    this.adapters.set(adapter.surface, adapter);
    if (adapter.surface === this.preferredSurface) {
      const waiters = [...this.waiters];
      this.waiters.clear();
      for (const w of waiters) w();
    }
    return this;
  }

  /** Resolves once the preferred surface has an adapter. `cancel` drops the wait without resolving. */
  whenPreferred(): { ready: Promise<void>; cancel(): void } {
    if (this.hasPreferred()) return { ready: Promise.resolve(), cancel: () => {} };
    let waiter!: () => void;
    const ready = new Promise<void>((resolve) => {
      waiter = resolve;
      this.waiters.add(waiter);
    });
    return { ready, cancel: () => this.waiters.delete(waiter) };
  }

  get(surface: string): SurfaceAdapter | undefined {
    return this.adapters.get(surface);
  }

  /** The adapter for `origin`, or the preferred surface's default conversation when there is no origin, its
   *  surface isn't registered, or the registry is pinned. Throws when the preferred surface isn't registered. */
  resolve(origin: ChatOrigin | null | undefined): ResolvedSurface {
    const own = origin && (!this.pinned || origin.surface === this.preferredSurface) ? this.adapters.get(origin.surface) : undefined;
    if (own) return { adapter: own, origin: origin! };
    const preferred = this.adapters.get(this.preferredSurface);
    if (!preferred) throw new SurfaceUnavailableError(`no adapter for the preferred surface "${this.preferredSurface}"`);
    return { adapter: preferred, origin: null };
  }
}
