import { existsSync } from "node:fs";
import type { AgentSession, AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  RPC_METHODS,
  chatAbortParams,
  chatAckParams,
  chatMessageParams,
  chatNewParams,
  type ChatAbortResult,
  type ChatDeliverParams,
  type ChatEventPayload,
  type ChatMessageParams,
  type ChatMessageResult,
  type ChatNewResult,
  type ChatOrigin,
} from "../orchestration/contracts.ts";
import { ulid } from "./ulid.ts";
import { getLogger } from "../logger.ts";
import { failureNotice, mapSessionEvent, newRunAccumulator, replyText, runAborted, runUsage, type RunAccumulator } from "./events.ts";
import { Outbox } from "./outbox.ts";
import { RecentIds } from "./recentIds.ts";
import { readWorkspaceState, writeWorkspaceState } from "./state.ts";
import { ChatAsks, createHeadlessUIContext, type AskRequest } from "./uiContext.ts";
import {
  COMPACTION_FLUSH_TIMEOUT_MS,
  FLUSH_MARKER,
  FLUSH_TIMEOUT_MS,
  NEW_BUDGET_MS,
  flushMarginTokens,
  flushPrompt,
  newFinishReserveMs,
  newMinFlushMs,
  type FlushReason,
} from "./memoryFlush.ts";

const log = getLogger("workspace.session");

const VOICE_MARKER = "voice message, transcribed";
const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE = /^\d{17,20}$/;
const CONTEXT_CUSTOM_TYPE = "workspace_context";
const RECAP_CUSTOM_TYPE = "workspace_recap";
const IDLE_CHECK_MS = 60_000;
/** How long a workspace-initiated ask (the stale-task review) stays answerable. */
const OWNER_ASK_TIMEOUT_MS = 24 * 60 * 60_000;
/** How long `!compact` waits for a running turn to end before compacting anyway. */
const COMPACT_WAIT_MS = 5 * 60_000;
export const STOP_NOTE =
  "[note] drk stopped the previous turn with !stop. If it concerned an item in TASKS.md, reconcile that item now (mark it [-] with a one-line reason, or update it).";
/** How long a pre-compaction flush's abort may take before the chain moves on. */
const FLUSH_ABORT_MS = 10_000;

/** The slice of Pi's AgentSession the host drives; tests supply a fake. */
export type ChatSession = Pick<
  AgentSession,
  | "isStreaming"
  | "isCompacting"
  | "pendingMessageCount"
  | "prompt"
  | "abort"
  | "clearQueue"
  | "subscribe"
  | "sendCustomMessage"
  | "getContextUsage"
  | "messages"
  | "dispose"
>;

/** Opens `sessionFile` when given, else creates a fresh chat session, its extensions bound to `ui`. */
export type ChatSessionFactory = (input: { sessionFile: string | null; ui?: ExtensionUIContext }) => Promise<{
  session: ChatSession;
  sessionFile: string;
  /** The run in progress on `session` (a subagent's parentRunId); null between runs. */
  currentRunId?: () => string | null;
}>;

export interface ChatTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** When absent the link is assumed up. */
  isConnected?(): boolean;
}

const RESEND_INTERVAL_MS = 60_000;
// The bot answers chat/deliver at once but drops a request that lands before its register reply; without a
// deadline that send stays "unanswered" and the interval resend skips it until the next reconnect.
const DELIVER_TIMEOUT_MS = 30_000;

/** Memory upkeep around the chat session; tests supply fakes. */
export interface MemoryHooks {
  /** Tokens past which Pi auto-compacts `session`, or null when compaction is off or the window unknown. */
  compactionTrigger(session: ChatSession): number | null;
  /** Re-reads the home context files into `session`'s system prompt. */
  reload(session: ChatSession): Promise<void>;
  /**
   * Commits the memory files (USER.md, MEMORY.md, DREAMS.md, memory/) with a "memory:" message; a no-op when
   * none changed. SOUL.md, AGENTS.md and .agents/ are never auto-committed: persona and skill edits are left
   * for the owner to review and commit.
   */
  commit(message: string): Promise<unknown>;
  /** A fingerprint of the memory files, to skip the commit after a turn that changed none. */
  signature(): string;
  /** Appends the deterministic handoff note for a chat/new whose flush didn't complete. */
  handoff?(session: ChatSession, outcome: FlushOutcome): void;
  /** Whether `session` completed a flush since its last compaction; seeds the once-per-cycle guard on attach. */
  flushRanThisCycle?(session: ChatSession): boolean;
  /** Cap on one flush turn. Default FLUSH_TIMEOUT_MS for chat/new, COMPACTION_FLUSH_TIMEOUT_MS before compaction. */
  flushTimeoutMs?: number;
  /** Default flushMarginTokens(trigger). */
  flushMarginTokens?: number;
  /** The whole chat/new, flush included. Default NEW_BUDGET_MS. */
  newBudgetMs?: number;
}

export type FlushOutcome = "done" | "timeout" | "cut" | "failed" | "skipped";

/** Context upkeep beyond memory: `!compact` and idle rotation. Tests supply fakes. */
export interface ContextHooks {
  /** Compacts `session` now; tokens before and (estimated) after. */
  compact(session: ChatSession): Promise<{ tokensBefore: number; tokensAfter: number | null }>;
  /** A recap of `session` for the next one to start from; null when none could be made. */
  recap(session: ChatSession): Promise<string | null>;
  /** How long `session` must be idle before it rotates. */
  idleRotateMs(session: ChatSession): number;
  /** Rotation only happens above this many context tokens. */
  rotateTokens: number;
  /** Work for main still running outside the session (a background subagent): no rotation meanwhile. */
  busy?(): boolean;
  /** After a rotation, for the run log. */
  onRotated?(r: RotationRecord): void;
  /** How often idleness is checked. Default 60s; null leaves it to checkIdle() calls. */
  checkEveryMs?: number | null;
}

export interface RotationRecord {
  previousSessionFile: string;
  sessionFile: string;
  tokensBefore: number;
  tokensAfter: number | null;
  recapped: boolean;
  startedAt: Date;
}

/** The flush prompt whose run the next agent_start opens; abandoned once the flush timed out or was cut. */
interface HiddenPrompt {
  abandoned: boolean;
}

export interface PersonalSessionOptions {
  principalId: string;
  model: string;
  stateDir: string;
  factory: ChatSessionFactory;
  transport: ChatTransport;
  /** Coalescing window for text_delta events; null omits them. Default 500ms. */
  textDeltaMs?: number | null;
  newId?: () => string;
  fileExists?: (path: string) => boolean;
  /** How often unacked deliveries are resent while connected. Default 60s. */
  resendIntervalMs?: number;
  deliverTimeoutMs?: number;
  /** Receipt time for messages whose id isn't a Discord snowflake. */
  now?: () => Date;
  /** When set: flush memory before chat/new and before compaction, and commit memory changes after turns. */
  memory?: MemoryHooks;
  /** How long an extension dialog waits for the owner. Default ASK_TIMEOUT_MS. */
  askTimeoutMs?: number;
  context?: ContextHooks;
  /** Idle-time clock (ms). Default Date.now. */
  clock?: () => number;
}

interface OpenRun {
  turnId: string;
  /** The prompting message's origin; the run's events and reply go back to it. */
  origin: ChatOrigin | undefined;
  /** The prompting message; the reply's replyTo when the latest steer came from another conversation. */
  promptMessageId: string | undefined;
  acc: RunAccumulator;
  deltaBuffer: string;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  abortRequested: boolean;
  suppressReply: boolean;
  /** A memory flush: no chat events, no reply. */
  hidden: boolean;
}

/** A user message handed to Pi that it hasn't yet turned into a user message_start. */
interface PendingInbound {
  messageId: string;
  text: string;
  origin: ChatOrigin | undefined;
  /** Set for a wake: consuming it marks the wake received. */
  wakeId?: string;
}

/** A host-initiated prompt (a background subagent's result) that must reach the session exactly when it is idle. */
export interface Wake {
  id: string;
  text: string;
  /** The run it starts replies here. */
  origin?: ChatOrigin;
  /** Called once the session has the message. */
  onConsumed: () => void;
}

interface WakeState extends Wake {
  /** idle: waiting for a chain slot; queued: a chain item will prompt it; prompted: Pi accepted it. */
  state: "idle" | "queued" | "prompted";
  failures: number;
}

const WAKE_MAX_FAILURES = 5;

interface BufferedContext {
  messageId: string;
  text: string;
}

/** How the most recent settle ended, so a late prompt rejection knows whether the user already heard something. */
type SettleOutcome = "reply" | "notice" | "aborted" | "suppressed" | "silent";

/** The owner's single long-lived Pi session behind the chat/* verbs, replying through the outbox. */
export class PersonalSession {
  private readonly opts: PersonalSessionOptions;
  private readonly outbox: Outbox;
  private readonly recentIds: RecentIds;
  private readonly newId: () => string;
  private session: ChatSession | null = null;
  private sessionFile = "";
  private unsubscribe: (() => void) | null = null;
  // Bumped on every session swap so late events from a retired session are ignored.
  private generation = 0;
  // Serial inbound queue; doubles as the hold queue while chat/new swaps sessions.
  private chain: Promise<unknown> = Promise.resolve();
  private resetting = false;
  private run: OpenRun | null = null;
  private lastInboundId: string | undefined;
  private lastOrigin: ChatOrigin | undefined;
  // The message whose prompt() starts the next run; a later steer can't become the run's origin.
  private nextRunPrompt: PendingInbound | undefined;
  private unconsumed: PendingInbound[] = [];
  // A retry of a message still being handled shares its outcome: a failure must reach the retry too.
  private readonly inFlight = new Map<string, Promise<ChatMessageResult>>();
  private settleCount = 0;
  private lastSettle: { outcome: SettleOutcome; turnId?: string } = { outcome: "silent" };
  private pendingContext: BufferedContext[] = [];
  // Context appended to a session Pi hasn't written to disk yet (no assistant message so far).
  private unpersistedContextIds: string[] = [];
  private compactionWaiters: Array<() => void> = [];
  private settleWaiters: Array<() => void> = [];
  private readonly sending = new Set<string>();
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  // The next run to start is a memory flush.
  private hiddenNext: HiddenPrompt | null = null;
  // An abandoned flush prompt still in Pi's preflight: user prompts wait for it so they can't join or become its run.
  private orphanFlush: Promise<void> | null = null;
  // Cuts the flush in progress short (chat/new, /stop).
  private flushCut: { reason: FlushReason; cut: (abortBy?: number) => void } | null = null;
  private lastHiddenRunOk = false;
  // settleCount right after the last completed flush; equal to settleCount while no turn has run since.
  private lastFlushDoneAt = -1;
  // chat/new calls not yet finished; a soft flush that would run ahead of or after one is dropped.
  private pendingNew = 0;
  // Once per compaction cycle: cleared by a completed compaction or a session swap.
  private flushedThisCycle = false;
  private memorySignature: string | null = null;
  private turnCommit: Promise<void> = Promise.resolve();
  // Tasks on the serial chain not yet finished.
  private queued = 0;
  private reloadDue = false;
  private readonly asks: ChatAsks;
  // Asks the workspace itself sends outside any turn (the TASKS.md review): never cancelled by a run ending.
  private readonly ownerAsks: ChatAsks;
  /** Bound into every session the factory builds, so extension dialogs reach the owner as asks. */
  readonly ui: ExtensionUIContext;
  private readonly wakes = new Map<string, WakeState>();
  private readonly wakesDone = new Set<string>();
  private lastActivityAt = 0;
  // lastActivityAt of the idle window that already rotated (or tried to).
  private rotatedWindow = -1;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PersonalSessionOptions) {
    this.opts = opts;
    this.outbox = new Outbox(opts.stateDir);
    this.recentIds = new RecentIds(opts.stateDir);
    this.newId = opts.newId ?? ulid;
    this.asks = new ChatAsks({ deliver: (ask) => this.deliverAsk(ask), timeoutMs: opts.askTimeoutMs, newId: this.newId });
    this.ui = createHeadlessUIContext(this.asks);
    this.ownerAsks = new ChatAsks({ deliver: (ask) => this.deliverOwnerAsk(ask), timeoutMs: OWNER_ASK_TIMEOUT_MS, newId: this.newId });
    this.lastActivityAt = this.clock();
  }

  private clock(): number {
    return this.opts.clock?.() ?? Date.now();
  }

  private touch(): void {
    this.lastActivityAt = this.clock();
  }

  get state(): "idle" | "streaming" {
    return this.session?.isStreaming ? "streaming" : "idle";
  }

  /** Nothing in progress or waiting: no run, compaction, flush, chat/new, or inbound message still being handled. */
  isIdle(): boolean {
    const s = this.session;
    if (!s || s.isStreaming || s.isCompacting || s.pendingMessageCount > 0) return false;
    return (
      !this.run &&
      !this.resetting &&
      this.pendingNew === 0 &&
      this.queued === 0 &&
      this.inFlight.size === 0 &&
      this.pendingContext.length === 0 &&
      this.hiddenNext === null &&
      this.orphanFlush === null
    );
  }

  /** Re-reads the home context files into the live session at its next idle point; a new session reads them anyway. */
  requestContextReload(): void {
    this.reloadDue = true;
    this.scheduleReload();
  }

  private scheduleReload(): void {
    const gen = this.generation;
    void this.enqueue(async () => {
      const session = this.session;
      const reload = this.opts.memory?.reload;
      if (!this.reloadDue || !session || !reload || gen !== this.generation) return;
      // Still busy: the next settle or compaction_end schedules it again.
      if (session.isStreaming || session.isCompacting || this.run) return;
      this.reloadDue = false;
      await reload(session);
    }).catch((err) => log.warn({ err }, "context reload after consolidation failed"));
  }

  get isResetting(): boolean {
    return this.resetting;
  }

  /** The live chat session, or null before start(). */
  get chatSession(): ChatSession | null {
    return this.session;
  }

  get currentSessionFile(): string {
    return this.sessionFile;
  }

  /** Reopens the chat session recorded in state.json, or creates one and records it. */
  async start(): Promise<void> {
    const exists = this.opts.fileExists ?? existsSync;
    const recorded = readWorkspaceState(this.opts.stateDir);
    const reopen = recorded && exists(recorded.chatSessionFile) ? recorded.chatSessionFile : null;
    const { session, sessionFile } = await this.opts.factory({ sessionFile: reopen, ui: this.ui });
    this.attach(session, sessionFile);
    // A rotation's recap lives only in memory until the new session's first message; a restart before then re-seeds it.
    const stash = recorded?.recap;
    if (stash && reopen === null && stash.sessionFile === recorded?.chatSessionFile) {
      await this.seedRecap(session, stash.text).catch((err) => log.warn({ err }, "re-seeding the rotation recap failed"));
      writeWorkspaceState(this.opts.stateDir, { chatSessionFile: sessionFile, recap: { sessionFile, text: stash.text } });
      log.info({ sessionFile }, "re-seeded the recap of the rotated session");
    } else if (recorded?.chatSessionFile !== sessionFile) writeWorkspaceState(this.opts.stateDir, { chatSessionFile: sessionFile, recap: undefined });
    this.touch();
    const every = this.opts.context?.checkEveryMs === undefined ? IDLE_CHECK_MS : this.opts.context.checkEveryMs;
    if (this.opts.context && every !== null && !this.idleTimer) {
      this.idleTimer = setInterval(() => void this.checkIdle().catch((err) => log.warn({ err }, "idle rotation check failed")), every);
      this.idleTimer.unref?.();
    }
    log.info({ sessionFile, reopened: reopen !== null }, "personal session ready");
  }

  handlers(): Record<string, (params: unknown) => Promise<unknown>> {
    return {
      [RPC_METHODS.chatMessage]: async (p) => {
        const params = chatMessageParams.parse(p);
        this.assertPrincipal(params.principalId);
        return this.handleMessage(params);
      },
      [RPC_METHODS.chatAbort]: async (p) => {
        const params = chatAbortParams.parse(p);
        this.assertPrincipal(params.principalId);
        return this.handleAbort(params.turnId);
      },
      [RPC_METHODS.chatNew]: async (p) => {
        this.assertPrincipal(chatNewParams.parse(p).principalId);
        return this.handleNew();
      },
      [RPC_METHODS.chatAck]: async (p) => this.handleAck(chatAckParams.parse(p).outboxId),
    };
  }

  async handleMessage(params: ChatMessageParams): Promise<ChatMessageResult> {
    this.touch();
    const id = params.messageId;
    if (this.isSeen(id)) return DUPLICATE;
    const original = this.inFlight.get(id);
    if (original) return original.then(() => DUPLICATE);
    // Ahead of the chain: the run waiting on the dialog holds up everything queued behind it.
    const answered = params.kind === "user" ? (this.ownerAsks.answer(id, params.text, { foreignIds: true }) ?? this.asks.answer(id, params.text)) : null;
    if (answered) {
      this.recentIds.add(id);
      return answered === "answered" ? { accepted: true, mode: "prompt" } : DUPLICATE;
    }
    const handling = this.accept(params);
    this.inFlight.set(id, handling);
    try {
      return await handling;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async accept(params: ChatMessageParams): Promise<ChatMessageResult> {
    const id = params.messageId;
    // Stamped once here: steers re-prompted from Pi's queue and buffered context already carry it.
    const text = formatUserText(params, this.opts.now?.() ?? new Date());
    if (params.kind === "context") {
      await this.enqueue(() => this.appendContext(id, text));
      return { accepted: true, mode: "context" };
    }
    const mode = await this.enqueue(() => this.promptOrSteer(id, text, params.origin));
    this.recentIds.add(id);
    return { accepted: true, mode };
  }

  private isSeen(id: string): boolean {
    return this.recentIds.has(id) || this.unpersistedContextIds.includes(id) || this.pendingContext.some((c) => c.messageId === id);
  }

  // Chained so a steer can't slip into Pi's queue between clearQueue() and abort(). Queued steers are dropped:
  // otherwise Pi continues on them after the abort and abort() waits out that whole run.
  handleAbort(turnId?: string): Promise<ChatAbortResult> {
    // A flush holds the chain for minutes; /stop cuts it instead of waiting out the bot's 30s timeout behind it.
    this.flushCut?.cut();
    // abort() waits for the run, which may be parked in an extension dialog, or open a new one before it lands.
    const release = turnId === undefined || this.run?.turnId === turnId ? this.asks.hold("stop") : () => {};
    return this.enqueue(async () => {
      const session = this.session;
      if (!session) return { aborted: false };
      if (turnId !== undefined && this.run?.turnId !== turnId) return { aborted: false };
      const aborted = session.isStreaming;
      this.dropQueued(session);
      if (this.run) this.run.abortRequested = true;
      // Lands before the next prompt, like context that arrives mid-run.
      if (aborted && this.run && !this.run.hidden) this.pendingContext.push({ messageId: `stop:${this.newId()}`, text: STOP_NOTE });
      await session.abort();
      return { aborted };
    }).finally(release);
  }

  handleNew(): Promise<ChatNewResult> {
    return this.replaceSession("new").then(({ sessionFile }) => ({ sessionFile }));
  }

  /**
   * Swaps in a fresh session: aborts the old one's run, flushes memory, and for a rotation seeds the new
   * session with a recap of the old one. Messages arriving meanwhile queue behind it on the chain and
   * land in the new session.
   */
  private replaceSession(
    reason: "new" | "rotate",
    rotate?: { guard: () => boolean },
  ): Promise<{ sessionFile: string; rotated: RotationRecord | null }> {
    // Stamped before queuing: time spent behind a soft flush or a steer counts against the bot's timeout too.
    const budgetMs = this.opts.memory?.newBudgetMs ?? NEW_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const reserve = newFinishReserveMs(budgetMs);
    this.pendingNew++;
    // The flush turn on the old session can open dialogs; nobody is left to answer them.
    const release = this.asks.hold(reason === "new" ? "new session" : "session rotation");
    if (reason === "new" && this.flushCut?.reason === "compaction") this.flushCut.cut(deadline - reserve);
    return this.enqueue(async () => {
      const old = this.session;
      // Re-checked on the chain: a message may have arrived since the idle check.
      if (rotate && (!old || !rotate.guard())) return { sessionFile: this.sessionFile, rotated: null };
      this.resetting = true;
      try {
        const startedAt = new Date();
        const previousSessionFile = this.sessionFile;
        const tokensBefore = old?.getContextUsage()?.tokens ?? 0;
        let recap: string | null = null;
        if (old) {
          this.dropQueued(old);
          this.retireContext();
          if (this.run) {
            this.run.abortRequested = true;
            this.run.suppressReply = true;
          }
          // Abort while still subscribed, so the retired run closes with turn_end{aborted}.
          if (old.isStreaming && (await bounded(old.abort(), deadline - reserve - Date.now())) === TIMEOUT) {
            log.warn("aborting the old session's run before reset didn't finish in time; resetting anyway");
          }
          // After the abort: a flush sent into a live run would join it as a steer.
          await this.flushBeforeNew(old, deadline, budgetMs, reason);
          if (reason === "rotate") recap = await this.makeRecap(old, deadline - reserve);
        }
        // Build the replacement first: if that fails, the old session stays attached and usable.
        const { session, sessionFile } = await this.opts.factory({ sessionFile: null, ui: this.ui });
        this.detach();
        old?.dispose();
        this.attach(session, sessionFile);
        const text = recap === null ? null : recapMessage(recap, previousSessionFile);
        if (text !== null) await this.seedRecap(session, text).catch((err) => log.warn({ err }, "seeding the recap failed"));
        writeWorkspaceState(this.opts.stateDir, { chatSessionFile: sessionFile, recap: text === null ? undefined : { sessionFile, text } });
        if (reason === "new") {
          log.info({ sessionFile }, "started a new chat session");
          return { sessionFile, rotated: null };
        }
        const rotated: RotationRecord = {
          previousSessionFile,
          sessionFile,
          tokensBefore,
          tokensAfter: session.getContextUsage()?.tokens ?? null,
          recapped: text !== null,
          startedAt,
        };
        log.info({ ...rotated, startedAt: undefined }, "rotated the idle chat session");
        try {
          this.opts.context?.onRotated?.(rotated);
        } catch (err) {
          log.warn({ err }, "recording the rotation failed");
        }
        return { sessionFile, rotated };
      } finally {
        this.resetting = false;
        this.touch();
      }
    }).finally(() => {
      this.pendingNew--;
      release();
    });
  }

  private async makeRecap(session: ChatSession, deadline: number): Promise<string | null> {
    const recap = this.opts.context?.recap;
    if (!recap) return null;
    try {
      const out = await bounded(recap(session), Math.max(deadline - Date.now(), 1000));
      if (out === TIMEOUT) {
        log.warn("the recap didn't finish in time; rotating without one");
        return null;
      }
      return out;
    } catch (err) {
      log.warn({ err }, "the recap failed; rotating without one");
      return null;
    }
  }

  private async seedRecap(session: ChatSession, text: string): Promise<void> {
    await session.sendCustomMessage({ customType: RECAP_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: false });
  }

  /** Whether the session has sat idle long enough, and is big enough, to rotate now. */
  private rotationDue(): boolean {
    const ctx = this.opts.context;
    const session = this.session;
    if (!ctx || !session || !this.isIdle() || this.wakes.size > 0 || ctx.busy?.()) return false;
    if (this.rotatedWindow === this.lastActivityAt) return false;
    if (this.clock() - this.lastActivityAt < ctx.idleRotateMs(session)) return false;
    const tokens = session.getContextUsage()?.tokens;
    return tokens != null && tokens > ctx.rotateTokens;
  }

  /** Rotates the session when it is idle and big: at most once per idle window. */
  async checkIdle(): Promise<RotationRecord | null> {
    if (!this.rotationDue()) return null;
    this.rotatedWindow = this.lastActivityAt;
    const { rotated } = await this.replaceSession("rotate", { guard: () => this.rotationDueOnChain() });
    // The swap touched the clock; this window counts as rotated too.
    this.rotatedWindow = this.lastActivityAt;
    return rotated;
  }

  // On the chain the task itself counts as queued, so isIdle() can't be used as is.
  private rotationDueOnChain(): boolean {
    const s = this.session;
    if (!s || s.isStreaming || s.isCompacting || s.pendingMessageCount > 0 || this.run || this.hiddenNext || this.orphanFlush) return false;
    return this.queued === 1 && this.inFlight.size === 0 && this.pendingContext.length === 0 && this.pendingNew === 1 && !this.opts.context?.busy?.();
  }

  /** `!compact`: after the turn in progress, flush memory, compact with the anchored summary, reload the context files. */
  compactNow(): Promise<{ tokensBefore: number; tokensAfter: number | null } | { error: string }> {
    const ctx = this.opts.context;
    if (!ctx) return Promise.resolve({ error: "compaction isn't available here" });
    this.touch();
    return this.enqueue(async () => {
      const session = this.requireSession();
      const waitEnd = Date.now() + COMPACT_WAIT_MS;
      await this.waitForCompaction();
      while ((this.run || session.isStreaming) && Date.now() < waitEnd) {
        await bounded(new Promise<void>((r) => this.settleWaiters.push(r)), waitEnd - Date.now());
      }
      if (session !== this.session) return { error: "the session changed while waiting" };
      if (session.isStreaming) return { error: "a turn is still running; try again when it ends" };
      const memory = this.opts.memory;
      if (memory && this.lastFlushDoneAt !== this.settleCount && hasConversation(session)) {
        const deadline = Date.now() + (memory.flushTimeoutMs ?? COMPACTION_FLUSH_TIMEOUT_MS);
        await this.flushMemory(session, "compaction", { deadline, abortDeadline: deadline + FLUSH_ABORT_MS });
        await this.commitMemory("memory: flush before compaction");
      }
      if (session !== this.session) return { error: "the session changed during the memory flush" };
      try {
        const result = await ctx.compact(session);
        this.flushedThisCycle = false;
        if (memory) await memory.reload(session).catch((err) => log.warn({ err }, "context reload after !compact failed"));
        log.info(result, "compacted on request");
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err }, "!compact failed");
        return { error: message };
      } finally {
        this.touch();
      }
    });
  }

  // The replacement session is built fresh from the home files, so it needs no reload.
  private async flushBeforeNew(old: ChatSession, deadline: number, budgetMs: number, reason: "new" | "rotate" = "new"): Promise<void> {
    const memory = this.opts.memory;
    if (!memory) return;
    const reserve = newFinishReserveMs(budgetMs);
    await bounded(this.turnCommit, deadline - reserve - Date.now());
    if (hasConversation(old)) {
      let outcome: FlushOutcome;
      if (this.lastFlushDoneAt === this.settleCount) outcome = "done";
      else if (deadline - reserve - Date.now() < newMinFlushMs(budgetMs)) outcome = "skipped";
      else {
        const cap = Date.now() + (memory.flushTimeoutMs ?? FLUSH_TIMEOUT_MS);
        outcome = await this.flushMemory(old, reason, { deadline: Math.min(deadline - reserve, cap), abortDeadline: deadline - reserve / 2 });
      }
      if (outcome !== "done") this.writeResetHandoff(old, outcome);
    }
    const message = reason === "new" ? "memory: flush before new session" : "memory: flush before session rotation";
    if ((await bounded(this.commitMemory(message), Math.max(deadline - Date.now(), 1000))) === TIMEOUT) {
      log.warn("memory commit before reset didn't finish in time; it completes in the background");
    }
  }

  private writeResetHandoff(session: ChatSession, outcome: FlushOutcome): void {
    log.warn({ outcome }, "memory flush before reset didn't complete; writing the handoff note");
    try {
      this.opts.memory?.handoff?.(session, outcome);
    } catch (err) {
      log.warn({ err }, "writing the reset handoff note failed");
    }
  }

  /** Runs one hidden flush turn on `session`, bounded; call from inside the inbound chain so messages wait behind it. */
  private async flushMemory(session: ChatSession, reason: FlushReason, bound: { deadline: number; abortDeadline: number }): Promise<FlushOutcome> {
    if (this.orphanFlush) {
      log.warn({ reason }, "memory flush skipped: an abandoned flush is still starting");
      return "skipped";
    }
    let abortDeadline = bound.abortDeadline;
    let cut: (abortBy?: number) => void = () => {};
    const cutShort = new Promise<"cut">((resolve) => {
      cut = (abortBy) => {
        if (abortBy !== undefined) abortDeadline = Math.min(abortDeadline, abortBy);
        resolve("cut");
      };
    });
    const handle = { reason, cut };
    this.flushCut = handle;
    const hidden: HiddenPrompt = { abandoned: false };
    const timer = deadlineTimer(bound.deadline);
    try {
      const ready = await Promise.race([
        this.waitForCompaction()
          .then(() => this.waitForSettle())
          .then(() => "ready" as const),
        cutShort,
        timer.promise,
      ]);
      if (ready !== "ready") {
        log.warn({ reason, outcome: ready }, "memory flush skipped: the session stayed busy");
        return ready === "cut" ? "cut" : "skipped";
      }
      if (session !== this.session || session.isStreaming || session.isCompacting) return "skipped";
      this.hiddenNext = hidden;
      this.lastHiddenRunOk = false;
      const prompted = session.prompt(flushPrompt(reason), { expandPromptTemplates: false });
      const outcome = await Promise.race([prompted.then(() => "done" as const), cutShort, timer.promise]);
      if (outcome === "done") {
        if (!this.lastHiddenRunOk) {
          log.warn({ reason }, "memory flush run ended aborted or in error");
          return "failed";
        }
        this.lastFlushDoneAt = this.settleCount;
        log.info({ reason }, "memory flushed");
        return "done";
      }
      log.warn({ reason, outcome }, "memory flush cut short; aborting it and carrying on");
      hidden.abandoned = true;
      if (this.run?.hidden) this.run.abortRequested = true;
      const aborting = session.abort().catch((err) => log.warn({ err }, "aborting the memory flush failed"));
      if ((await bounded(aborting, abortDeadline - Date.now())) === TIMEOUT) log.warn({ reason }, "aborting the memory flush didn't finish in time");
      if (this.hiddenNext === hidden) {
        // Still in preflight, so abort() had no run to stop; agent_start aborts it once it starts.
        const orphan: Promise<void> = prompted
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            if (this.hiddenNext === hidden) this.hiddenNext = null;
            if (this.orphanFlush === orphan) this.orphanFlush = null;
          });
        this.orphanFlush = orphan;
      }
      return outcome;
    } catch (err) {
      if (isCompactionBusy(err)) log.info({ reason }, "memory flush skipped: compaction in progress");
      else log.warn({ err, reason }, "memory flush failed");
      return isCompactionBusy(err) ? "skipped" : "failed";
    } finally {
      timer.clear();
      if (this.flushCut === handle) this.flushCut = null;
      if (this.hiddenNext === hidden && this.orphanFlush === null) this.hiddenNext = null;
    }
  }

  private async commitMemory(message: string): Promise<void> {
    const memory = this.opts.memory;
    if (!memory) return;
    try {
      // Snapshot before committing: a write landing while git runs must still read as a change afterwards.
      for (let attempt = 0; attempt < 3; attempt++) {
        const signature = memory.signature();
        await memory.commit(message);
        this.memorySignature = signature;
        if (memory.signature() === signature) return;
      }
    } catch (err) {
      this.memorySignature = null;
      log.warn({ err }, "memory commit failed");
    }
  }

  /** After a chat turn: commit memory it changed, then flush if the context sits just below the compaction trigger. */
  private afterTurn(session: ChatSession, turnId: string): void {
    const memory = this.opts.memory;
    if (!memory) return;
    if (memory.signature() !== this.memorySignature) this.turnCommit = this.commitMemory(`memory: turn ${turnId}`);
    if (this.flushedThisCycle || this.resetting || session.isCompacting) return;
    const usage = session.getContextUsage();
    const trigger = memory.compactionTrigger(session);
    if (usage?.tokens == null || trigger === null) return;
    // At or past the trigger the flush's own prompt would compact first; the session_before_compact handoff covers that.
    const soft = trigger - (memory.flushMarginTokens ?? flushMarginTokens(trigger));
    if (usage.tokens < soft || usage.tokens >= trigger) return;
    this.flushedThisCycle = true;
    const gen = this.generation;
    void this.enqueue(async () => {
      // A chat/new already asked for runs its own flush; this one would only eat its budget.
      if (gen !== this.generation || this.pendingNew > 0) return;
      // Settled first, so the turn's commit can't sweep up the flush's edits under its own message.
      await this.turnCommit;
      const timeoutMs = memory.flushTimeoutMs ?? COMPACTION_FLUSH_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const outcome = await this.flushMemory(session, "compaction", { deadline, abortDeadline: deadline + Math.min(FLUSH_ABORT_MS, timeoutMs) });
      if (outcome === "skipped") return;
      await this.commitMemory("memory: flush before compaction");
      if (gen !== this.generation || session.isStreaming || this.pendingNew > 0 || this.orphanFlush) return;
      await memory.reload(session);
    }).catch((err) => log.warn({ err }, "pre-compaction memory flush failed"));
  }

  handleAck(outboxId: string): Record<string, never> {
    if (!this.outbox.ack(outboxId)) log.debug({ outboxId }, "ack for an unknown or already-acked outbox entry");
    return {};
  }

  /** Called after every (re)register: resends right away, then keeps retrying on an interval while connected. */
  onRegistered(): void {
    this.resendUnacked();
    if (this.resendTimer) return;
    this.resendTimer = setInterval(() => {
      if (this.opts.transport.isConnected?.() ?? true) this.resendUnacked();
    }, this.opts.resendIntervalMs ?? RESEND_INTERVAL_MS);
    this.resendTimer.unref?.();
  }

  /** The bot dedupes by outboxId, so resending is safe; an entry whose last send is still unanswered is skipped. */
  resendUnacked(): void {
    for (const entry of this.outbox.unacked()) {
      if (!this.sending.has(entry.outboxId)) this.send(entry);
    }
  }

  /**
   * Prompts `w.text` as its own run once the session is idle, never as a steer or through Pi's queues, so a
   * queue clear (stop, /new, a stranded-steer requeue) or a hidden flush can't drop it. A wake whose run ends
   * before Pi took the message is prompted again; a repeat of a known id is ignored.
   */
  wake(w: Wake): void {
    if (this.wakes.has(w.id) || this.wakesDone.has(w.id)) return;
    this.wakes.set(w.id, { ...w, state: "idle", failures: 0 });
    this.pumpWakes();
  }

  private pumpWakes(): void {
    for (const w of this.wakes.values()) {
      if (w.state !== "idle") continue;
      w.state = "queued";
      void this.enqueue(() => this.promptWake(w)).catch((err) => {
        w.state = "idle";
        if (++w.failures >= WAKE_MAX_FAILURES) {
          this.wakes.delete(w.id);
          log.error({ err, wakeId: w.id }, "giving up on a wake; it stays pending for the next start");
        } else {
          log.warn({ err, wakeId: w.id }, "a wake prompt failed; retrying at the next settle");
        }
      });
    }
  }

  private async promptWake(w: WakeState): Promise<void> {
    if (this.wakes.get(w.id) !== w || w.state !== "queued") return;
    if (this.orphanFlush) await this.orphanFlush;
    await this.waitForCompaction();
    await this.waitForSettle();
    // Joining a live run as a steer would answer in that run's conversation; the next settle pumps it again.
    if (this.requireSession().isStreaming || this.resetting) {
      w.state = "idle";
      return;
    }
    await this.promptOrSteer("", w.text, w.origin, w.id);
    if (this.wakes.get(w.id) === w && w.state === "queued") w.state = "prompted";
  }

  /** Called at settle and on a session swap: a prompted wake that never became a message goes around again. */
  private retryWakes(): void {
    for (const w of this.wakes.values()) if (w.state === "prompted") w.state = "idle";
    this.pumpWakes();
  }

  async dispose(): Promise<void> {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.asks.hold("shutdown");
    this.ownerAsks.hold("shutdown");
    const session = this.session;
    this.detach();
    if (session?.isStreaming) await session.abort().catch(() => {});
    session?.dispose();
    await this.turnCommit;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const next = this.chain.then(fn).finally(() => this.queued--);
    this.chain = next.catch(() => {});
    return next;
  }

  // Pi marks the run active only after async preflight, so gate the queue on preflightResult or a racing idle prompt starts a second run.
  private async promptOrSteer(messageId: string, text: string, origin: ChatOrigin | undefined, wakeId?: string): Promise<"prompt" | "steer"> {
    for (let attempt = 0; ; attempt++) {
      if (this.orphanFlush) await this.orphanFlush;
      await this.waitForCompaction();
      await this.waitForSettle();
      const session = this.requireSession();
      const mode = session.isStreaming ? "steer" : "prompt";
      // Context that arrived during the last run belongs before this prompt, not after its reply.
      if (mode === "prompt" && this.pendingContext.length) await this.flushPendingContext();
      // Registered before prompt(): Pi can drain a steer before it calls preflightResult.
      const pending: PendingInbound = { messageId, text, origin, ...(wakeId ? { wakeId } : {}) };
      this.unconsumed.push(pending);
      if (mode === "prompt") this.nextRunPrompt = pending;
      let accepted = false;
      let settlesAtAccept = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          session
            .prompt(text, {
              streamingBehavior: "steer",
              // Chat text is literal: a Discord message starting with "/" must not run a skill or extension command.
              expandPromptTemplates: false,
              // Called only for an accepted input ("started" | "queued" | "handled"); a rejection rejects prompt().
              preflightResult: () => {
                accepted = true;
                settlesAtAccept = this.settleCount;
                resolve();
              },
            })
            .then(resolve, (err) => {
              if (!accepted) return reject(err);
              log.error({ err, messageId }, "chat prompt failed after it was accepted");
              // Pi settles the run before this rejection lands; only speak up if that settle said nothing.
              const settled = this.settleCount !== settlesAtAccept;
              if (!settled) this.deliverFailure(err, messageId, this.run?.turnId, this.run?.origin ?? origin);
              else if (this.lastSettle.outcome === "silent") this.deliverFailure(err, messageId, this.lastSettle.turnId, origin);
            });
        });
        return mode;
      } catch (err) {
        this.unconsumed = this.unconsumed.filter((p) => p !== pending);
        if (this.nextRunPrompt === pending) this.nextRunPrompt = undefined;
        if (attempt === 0 && isCompactionBusy(err)) continue;
        log.error({ err, messageId }, "chat prompt failed");
        throw err;
      }
    }
  }

  private dropQueued(session: ChatSession): void {
    const { steering, followUp } = session.clearQueue();
    if (steering.length || followUp.length) log.info({ dropped: steering.length + followUp.length }, "dropped queued messages");
    this.unconsumed = [];
  }

  // Pi drains the steer queue only at the start of its next run, so a steer queued after the loop's last drain would wait for the next inbound message.
  private requeueStranded(session: ChatSession): void {
    const { steering, followUp } = session.clearQueue();
    const gen = this.generation;
    for (const text of [...steering, ...followUp]) {
      const i = this.unconsumed.findIndex((p) => p.text === text);
      const stranded = i === -1 ? undefined : this.unconsumed.splice(i, 1)[0];
      const messageId = stranded?.messageId;
      log.info({ messageId }, "re-prompting a steer stranded at settle");
      // A chat/new queued ahead of it drops it, like any other steer queued on the old conversation.
      void this.enqueue(async () => {
        if (gen === this.generation) await this.promptOrSteer(messageId ?? "", text, stranded?.origin);
      }).catch((err) => this.deliverFailure(err, messageId, undefined, stranded?.origin));
    }
  }

  private consumeInbound(text: string): void {
    const i = this.unconsumed.findIndex((p) => p.text === text);
    if (i === -1) return;
    // Earlier entries never became user messages (e.g. handled as extension commands); forget them.
    const entry = this.unconsumed[i];
    this.unconsumed.splice(0, i + 1);
    if (entry.wakeId) {
      // A wake isn't drk speaking: the reply threading keeps following drk's last message.
      const w = this.wakes.get(entry.wakeId);
      this.wakes.delete(entry.wakeId);
      this.wakesDone.add(entry.wakeId);
      if (this.wakesDone.size > 500) this.wakesDone.delete(this.wakesDone.values().next().value!);
      try {
        w?.onConsumed();
      } catch (err) {
        log.warn({ err, wakeId: entry.wakeId }, "marking a wake consumed failed");
      }
      return;
    }
    this.lastInboundId = entry.messageId || this.lastInboundId;
    this.lastOrigin = entry.origin ?? this.lastOrigin;
  }

  // Mid-run, sendCustomMessage(triggerTurn:false) would mutate the live message list; wait for settle.
  private async appendContext(messageId: string, text: string): Promise<void> {
    const session = this.requireSession();
    if (session.isStreaming || this.run) {
      this.pendingContext.push({ messageId, text });
      return;
    }
    await session.sendCustomMessage({ customType: CONTEXT_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: false });
    this.markContextAppended(session, messageId);
  }

  // Entries leave the buffer one at a time, so a failed append leaves the rest for the next idle point.
  private async flushPendingContext(): Promise<void> {
    const session = this.requireSession();
    while (this.pendingContext.length && !session.isStreaming && !this.run) {
      const { messageId, text } = this.pendingContext[0];
      await session.sendCustomMessage({ customType: CONTEXT_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: false });
      this.pendingContext.shift();
      this.markContextAppended(session, messageId);
    }
  }

  // Pi writes nothing to the session file until its first user or assistant message; until then a crash would lose the context.
  private markContextAppended(session: ChatSession, messageId: string): void {
    if (hasConversation(session)) this.recentIds.add(messageId);
    else this.unpersistedContextIds.push(messageId);
  }

  private commitUnpersistedContext(session: ChatSession): void {
    if (!this.unpersistedContextIds.length || !hasConversation(session)) return;
    for (const id of this.unpersistedContextIds.splice(0)) this.recentIds.add(id);
  }

  // The old conversation's context goes with it; its ids count as handled so a retry can't land in the new one.
  private retireContext(): void {
    for (const id of [...this.unpersistedContextIds.splice(0), ...this.pendingContext.splice(0).map((c) => c.messageId)]) {
      this.recentIds.add(id);
    }
  }

  private waitForCompaction(): Promise<void> {
    if (!this.session?.isCompacting) return Promise.resolve();
    return new Promise((resolve) => this.compactionWaiters.push(resolve));
  }

  // Pi clears isStreaming before it emits agent_settled; a prompt in that gap would merge into the closing run.
  private waitForSettle(): Promise<void> {
    if (!this.run || this.session?.isStreaming) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  private requireSession(): ChatSession {
    if (!this.session) throw new Error("personal session not started");
    return this.session;
  }

  private attach(session: ChatSession, sessionFile: string): void {
    const gen = ++this.generation;
    this.reloadDue = false;
    this.flushedThisCycle = this.opts.memory?.flushRanThisCycle?.(session) ?? false;
    this.lastFlushDoneAt = -1;
    this.session = session;
    this.sessionFile = sessionFile;
    this.unsubscribe = session.subscribe((event) => {
      if (gen === this.generation) this.onEvent(session, event);
    });
    this.retryWakes();
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.generation++;
    // An abandoned flush on the retired session must not mark the new session's first run hidden.
    this.hiddenNext = null;
    this.orphanFlush = null;
    this.closeRunWithoutReply();
    this.releaseCompactionWaiters();
    this.releaseSettleWaiters();
  }

  private onEvent(session: ChatSession, event: AgentSessionEvent): void {
    if (event.type === "compaction_end") {
      if (event.result && !event.aborted) this.flushedThisCycle = false;
      this.releaseCompactionWaiters();
      if (this.reloadDue) this.scheduleReload();
      return;
    }
    if (event.type === "message_start" && event.message.role === "user") {
      this.consumeInbound(userText(event.message));
    }
    if (event.type === "agent_start" && !this.run) {
      const hidden = this.hiddenNext;
      this.hiddenNext = null;
      const prompt = hidden ? undefined : this.nextRunPrompt;
      if (!hidden) this.nextRunPrompt = undefined;
      this.run = {
        turnId: this.newId(),
        origin: prompt?.origin ?? this.lastOrigin,
        promptMessageId: prompt?.messageId || undefined,
        acc: newRunAccumulator(),
        deltaBuffer: "",
        deltaTimer: null,
        abortRequested: hidden?.abandoned ?? false,
        suppressReply: false,
        hidden: hidden !== null,
      };
      if (hidden?.abandoned) void session.abort().catch((err) => log.warn({ err }, "aborting an abandoned memory flush failed"));
      this.emit({ type: "turn_start" });
      return;
    }
    if (event.type === "agent_settled") {
      this.settle(session);
      return;
    }
    const run = this.run;
    if (!run) return;
    for (const ev of mapSessionEvent(event, run.acc)) {
      if (ev.type === "text_delta") this.bufferDelta(run, ev.text);
      else this.emit(ev);
    }
  }

  private settle(session: ChatSession): void {
    const run = this.run;
    this.run = null;
    this.touch();
    this.asks.cancelAll("run ended");
    this.settleCount++;
    this.lastSettle = { outcome: run ? this.finishRun(session, run) : "silent", turnId: run?.turnId };
    this.releaseSettleWaiters();
    this.commitUnpersistedContext(session);
    if (this.pendingContext.length) {
      const gen = this.generation;
      void this.enqueue(async () => {
        if (gen === this.generation) await this.flushPendingContext();
      }).catch((err) => log.error({ err }, "failed to append buffered context"));
    }
    if (session.pendingMessageCount > 0 && !session.isCompacting) this.requeueStranded(session);
    if (run && !run.hidden) this.afterTurn(session, run.turnId);
    if (this.reloadDue) this.scheduleReload();
    this.retryWakes();
  }

  // turn_end.aborted means "no reply follows for this turn", so a reply suppressed by chat/new counts as aborted.
  private finishRun(session: ChatSession, run: OpenRun): SettleOutcome {
    if (run.hidden) {
      this.lastHiddenRunOk = !runAborted(run.acc, run.abortRequested) && run.acc.errorMessage === undefined;
      return "suppressed";
    }
    this.flushDelta(run);
    const aborted = runAborted(run.acc, run.abortRequested);
    this.emitFor(run, { type: "turn_end", aborted: aborted || run.suppressReply });
    if (aborted) return "aborted";
    if (run.suppressReply) return "suppressed";
    const usage = runUsage(run.acc, this.opts.model, session.getContextUsage()?.percent);
    // replyTo must name a message in the conversation the reply goes to.
    const replyTo = sameConversation(this.lastOrigin, run.origin) ? this.lastInboundId : run.promptMessageId;
    if (run.acc.errorMessage !== undefined) {
      this.deliver(failureNotice(run.acc.errorMessage), replyTo, run.turnId, run.origin, usage);
      return "notice";
    }
    const text = replyText(run.acc);
    if (text === null) return "silent";
    this.deliver(text, replyTo, run.turnId, run.origin, usage);
    return "reply";
  }

  private deliver(text: string, replyTo: string | undefined, turnId: string | undefined, origin: ChatOrigin | undefined, usage?: ChatDeliverParams["usage"]): void {
    const entry: ChatDeliverParams = {
      ...(origin ? { origin } : {}),
      outboxId: this.newId(),
      principalId: this.opts.principalId,
      kind: "reply",
      text,
      ...(replyTo ? { replyTo } : {}),
      ...(turnId ? { turnId } : {}),
      ...(usage ? { usage } : {}),
    };
    this.outbox.append(entry);
    this.send(entry);
  }

  /** A message outside any turn (a login prompt or result, a notice): outboxed like a reply, never added to the session. */
  deliverOutOfBand(d: Pick<ChatDeliverParams, "kind" | "text" | "origin" | "auth" | "authResult" | "loginId">): void {
    const entry: ChatDeliverParams = {
      ...(d.origin ? { origin: d.origin } : {}),
      outboxId: this.newId(),
      principalId: this.opts.principalId,
      kind: d.kind,
      text: d.text,
      ...(d.auth ? { auth: d.auth } : {}),
      ...(d.authResult ? { authResult: d.authResult } : {}),
      ...(d.loginId ? { loginId: d.loginId } : {}),
    };
    this.outbox.append(entry);
    this.send(entry);
  }

  /** Asks drk something outside any turn; resolves to the parsed answer, or undefined when it expires. */
  askOwner<T>(question: string, choices: string[], parse: (text: string) => { value: T } | null): Promise<T | undefined> {
    return this.ownerAsks.ask<T | undefined>(question, choices, parse, undefined);
  }

  // Like a proactive message: no turn, and the preferred surface.
  private deliverOwnerAsk(ask: AskRequest): void {
    const entry: ChatDeliverParams = {
      outboxId: this.newId(),
      principalId: this.opts.principalId,
      kind: "ask",
      text: ask.question,
      ask: ask.choices.length ? ask : { askId: ask.askId, question: ask.question },
    };
    this.outbox.append(entry);
    this.send(entry);
  }

  private deliverAsk(ask: AskRequest): void {
    const run = this.run;
    const origin = run?.origin ?? this.lastOrigin;
    const entry: ChatDeliverParams = {
      ...(origin ? { origin } : {}),
      outboxId: this.newId(),
      principalId: this.opts.principalId,
      kind: "ask",
      text: ask.question,
      ask: ask.choices.length ? ask : { askId: ask.askId, question: ask.question },
      ...(run ? { turnId: run.turnId } : {}),
    };
    this.outbox.append(entry);
    this.send(entry);
  }

  private deliverFailure(err: unknown, replyTo: string | undefined, turnId: string | undefined, origin: ChatOrigin | undefined): void {
    this.deliver(failureNotice(err instanceof Error ? err.message : String(err)), replyTo || undefined, turnId, origin);
  }

  private assertPrincipal(principalId: string): void {
    if (principalId !== this.opts.principalId) {
      throw new Error(`principal mismatch: this workspace serves ${this.opts.principalId}, got ${principalId}`);
    }
  }

  private send(entry: ChatDeliverParams): void {
    this.sending.add(entry.outboxId);
    this.opts.transport
      .request(RPC_METHODS.chatDeliver, entry, this.opts.deliverTimeoutMs ?? DELIVER_TIMEOUT_MS)
      .catch((err) => log.warn({ err, outboxId: entry.outboxId }, "chat/deliver not confirmed; will resend"))
      .finally(() => this.sending.delete(entry.outboxId));
  }

  private emit(ev: ChatEventPayload): void {
    if (this.run) this.emitFor(this.run, ev);
  }

  private emitFor(run: OpenRun, ev: ChatEventPayload): void {
    if (run.hidden) return;
    this.opts.transport.notify(RPC_METHODS.chatEvent, {
      ...(run.origin ? { origin: run.origin } : {}),
      principalId: this.opts.principalId,
      turnId: run.turnId,
      agentId: "main",
      ev,
    });
  }

  private bufferDelta(run: OpenRun, text: string): void {
    const ms = this.opts.textDeltaMs === undefined ? 500 : this.opts.textDeltaMs;
    if (ms === null || run.hidden) return;
    run.deltaBuffer += text;
    if (run.deltaTimer) return;
    run.deltaTimer = setTimeout(() => this.flushDelta(run), ms);
  }

  private flushDelta(run: OpenRun): void {
    if (run.deltaTimer) clearTimeout(run.deltaTimer);
    run.deltaTimer = null;
    if (!run.deltaBuffer) return;
    const text = run.deltaBuffer;
    run.deltaBuffer = "";
    this.emitFor(run, { type: "text_delta", text });
  }

  private closeRunWithoutReply(): void {
    const run = this.run;
    this.run = null;
    if (!run) return;
    this.asks.cancelAll("run closed");
    if (run.deltaTimer) clearTimeout(run.deltaTimer);
    this.emitFor(run, { type: "turn_end", aborted: true });
  }

  private releaseCompactionWaiters(): void {
    const waiters = this.compactionWaiters;
    this.compactionWaiters = [];
    for (const w of waiters) w();
  }

  private releaseSettleWaiters(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }
}

const DUPLICATE: ChatMessageResult = { accepted: true, mode: "duplicate" };

function recapMessage(recap: string, previousSessionFile: string): string {
  return [
    `Recap of our previous session (its transcript: ${previousSessionFile}; \`ws-runs\` has the detail):`,
    "",
    recap,
  ].join("\n");
}

function hasConversation(session: ChatSession): boolean {
  return session.messages.some((m) => m.role === "user" || m.role === "assistant");
}

const DEFAULT_SURFACE = "discord";

/** The Discord send time of a snowflake id, or null for any other id. */
export function snowflakeTime(id: string): Date | null {
  if (!SNOWFLAKE.test(id)) return null;
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS));
}

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * `[<surface>:<messageId> YYYY-MM-DD HH:MM UTC]`, the source a memory entry cites. Host-minted ids
 * (`inbox:…`, `wsask:…`) aren't surface messages, so they appear bare and can't pass for one.
 */
export function messageHeader(messageId: string, receivedAt: Date, opts: { surface?: string; voice?: boolean } = {}): string | null {
  const suffix = opts.voice ? `, ${VOICE_MARKER}` : "";
  if (!messageId) return opts.voice ? `[${VOICE_MARKER}]` : null;
  if (messageId.includes(":")) return `[${messageId} ${formatUtc(receivedAt)}${suffix}]`;
  const surface = opts.surface ?? DEFAULT_SURFACE;
  const sent = (surface === "discord" ? snowflakeTime(messageId) : null) ?? receivedAt;
  return `[${surface}:${messageId} ${formatUtc(sent)}${suffix}]`;
}

export function formatUserText(
  params: Pick<ChatMessageParams, "messageId" | "text" | "voice" | "attachments"> & { origin?: ChatOrigin },
  receivedAt: Date,
): string {
  const header = messageHeader(params.messageId, receivedAt, { surface: params.origin?.surface, voice: params.voice === true });
  let text = header ? `${header}\n${params.text}` : params.text;
  // Only the host's own flush prompts may start with the marker; flushRanThisCycle trusts it.
  if (text.startsWith(FLUSH_MARKER)) text = `[message]\n${text}`;
  // The workspace model is text-only; attachments reach it as links it can fetch with its tools.
  for (const a of params.attachments ?? []) text += `\n[attachment: ${a.name} (${a.contentType}) ${a.url}]`;
  return text;
}

function userText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

const TIMEOUT = Symbol("timeout");

function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  const timer = deadlineTimer(Date.now() + ms);
  return Promise.race([p, timer.promise.then((): typeof TIMEOUT => TIMEOUT)]).finally(timer.clear);
}

function deadlineTimer(deadline: number): { promise: Promise<"timeout">; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => (handle = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()))));
  return { promise, clear: () => clearTimeout(handle) };
}

function isCompactionBusy(err: unknown): boolean {
  return err instanceof Error && err.message.includes("while compaction is in progress");
}

function sameConversation(a: ChatOrigin | undefined, b: ChatOrigin | undefined): boolean {
  return a?.surface === b?.surface && a?.conversationId === b?.conversationId;
}
