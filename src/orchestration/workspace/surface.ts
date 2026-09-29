import type { ChatOrigin, ChatUsage, ToolCallResult } from "../contracts.ts";

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
}

export interface AskView {
  /** Null when the workspace sent a bare ask with no id: nothing to answer by button. */
  askId: string | null;
  question: string;
  /** Non-blank labels, in the workspace's order. */
  choices: string[];
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
}

/** One validated argument on an approval prompt, in the tool's fixed display order. */
export interface ApprovalField {
  key: string;
  value: string;
  /** `single` values are shown whole on one line; a `body` is shown as a block, clipped to `max`. */
  kind: "single" | "body";
  max: number;
}

export interface ApprovalView {
  tool: string;
  /** Self-reported by the workspace, so advisory. */
  agentId: string;
  agentName: string;
  fields: ApprovalField[];
}

export type ApprovalDecision = "approve" | "deny" | "timeout" | "expired";

/** Receipt signals on the user's message. */
export type AckKind = "accepted" | "steer" | "queued" | "newSession" | "stopped" | "transcribing";

/** Status lines the owner-message router posts in reply to a message. */
export type RouterNotice =
  | { type: "newSessionStarted" }
  | { type: "newSessionFailed"; error: string }
  | { type: "newWhileOffline" }
  | { type: "nothingToStop" }
  | { type: "stopFailed"; error: string }
  | { type: "transcriptionFailed" }
  | { type: "transcript"; text: string };

/** A user's message as the core sees it; adapters extend it with whatever they need to answer it. */
export interface InboundMessage {
  origin: ChatOrigin;
  id: string;
  text: string;
  author: { id: string; name: string };
  isVoice: boolean;
  attachments: Array<{ url: string; name: string; contentType: string }>;
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
export interface SurfaceAdapter<M extends InboundMessage = InboundMessage> extends InboundSurface<M> {
  readonly surface: string;
  readonly capabilities: SurfaceCapabilities;
  sendReply(origin: ChatOrigin | null, reply: ReplyView, attempt: SendAttempt): Promise<void>;
  askPrompt(origin: ChatOrigin | null, ask: AskView, attempt: SendAttempt): Promise<void>;
  progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<SurfaceMessageHandle>;
  progressUpdate(handle: SurfaceMessageHandle, view: ProgressView): Promise<void>;
  /** Edits the view into its final state, or posts the final state on its own when there is no view. */
  progressFinalize(origin: ChatOrigin | null, handle: SurfaceMessageHandle | null, final: ProgressFinal): Promise<void>;
  /** Re-opens a progress view an earlier process posted; null when it's gone. */
  progressReopen(origin: ChatOrigin | null, id: string): Promise<SurfaceMessageHandle | null>;
  approvalPrompt(origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<SurfaceMessageHandle>;
  /** Updates a posted prompt: decided, running (approve without result) or finished (with result). */
  resolveApproval(handle: SurfaceMessageHandle, view: ApprovalView, nonce: string, decision: ApprovalDecision, result?: ToolCallResult): Promise<void>;
}

/** The surface can't reach the principal at all (not a rendering failure). */
export class SurfaceUnavailableError extends Error {}

export interface ResolvedSurface {
  adapter: SurfaceAdapter;
  /** Null when the target is the principal's default conversation there. */
  origin: ChatOrigin | null;
}

/** Adapters keyed by surface id. Anything without a registered origin goes to the preferred surface. */
export class SurfaceRegistry {
  private readonly adapters = new Map<string, SurfaceAdapter>();

  constructor(readonly preferredSurface: string) {}

  register(adapter: SurfaceAdapter): this {
    this.adapters.set(adapter.surface, adapter);
    return this;
  }

  get(surface: string): SurfaceAdapter | undefined {
    return this.adapters.get(surface);
  }

  /** The adapter for `origin`, or the preferred surface's default conversation when there is no origin or
   *  its surface isn't registered. Throws when the preferred surface isn't registered either. */
  resolve(origin: ChatOrigin | null | undefined): ResolvedSurface {
    const own = origin ? this.adapters.get(origin.surface) : undefined;
    if (own) return { adapter: own, origin: origin! };
    const preferred = this.adapters.get(this.preferredSurface);
    if (!preferred) throw new SurfaceUnavailableError(`no adapter for the preferred surface "${this.preferredSurface}"`);
    return { adapter: preferred, origin: null };
  }
}
