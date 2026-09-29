import { existsSync } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
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
import { FLUSH_TIMEOUT_MS, flushMarginTokens, flushPrompt, type FlushReason } from "./memoryFlush.ts";

const log = getLogger("workspace.session");

const VOICE_MARKER = "voice message, transcribed";
const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE = /^\d{17,20}$/;
const CONTEXT_CUSTOM_TYPE = "workspace_context";

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

/** Opens `sessionFile` when given, else creates a fresh chat session. */
export type ChatSessionFactory = (input: { sessionFile: string | null }) => Promise<{ session: ChatSession; sessionFile: string }>;

export interface ChatTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** When absent the link is assumed up. */
  isConnected?(): boolean;
}

const RESEND_INTERVAL_MS = 60_000;

/** Memory upkeep around the chat session; tests supply fakes. */
export interface MemoryHooks {
  /** Tokens past which Pi auto-compacts `session`, or null when compaction is off or the window unknown. */
  compactionTrigger(session: ChatSession): number | null;
  /** Re-reads the home context files into `session`'s system prompt. */
  reload(session: ChatSession): Promise<void>;
  /** Commits the tracked memory files; a no-op when none changed. */
  commit(message: string): Promise<unknown>;
  /** A fingerprint of the tracked memory files, to skip the commit after a turn that changed none. */
  signature(): string;
  /** Default FLUSH_TIMEOUT_MS. */
  flushTimeoutMs?: number;
  /** Default flushMarginTokens(contextWindow). */
  flushMarginTokens?: number;
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
  /** Receipt time for messages whose id isn't a Discord snowflake. */
  now?: () => Date;
  /** When set: flush memory before chat/new and before compaction, and commit memory changes after turns. */
  memory?: MemoryHooks;
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
}

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
  private flushing = false;
  // Once per compaction cycle: cleared by a completed compaction or a session swap.
  private flushedThisCycle = false;
  private memorySignature: string | null = null;
  private turnCommit: Promise<void> = Promise.resolve();

  constructor(opts: PersonalSessionOptions) {
    this.opts = opts;
    this.outbox = new Outbox(opts.stateDir);
    this.recentIds = new RecentIds(opts.stateDir);
    this.newId = opts.newId ?? ulid;
  }

  get state(): "idle" | "streaming" {
    return this.session?.isStreaming ? "streaming" : "idle";
  }

  get isResetting(): boolean {
    return this.resetting;
  }

  get currentSessionFile(): string {
    return this.sessionFile;
  }

  /** Reopens the chat session recorded in state.json, or creates one and records it. */
  async start(): Promise<void> {
    const exists = this.opts.fileExists ?? existsSync;
    const recorded = readWorkspaceState(this.opts.stateDir);
    const reopen = recorded && exists(recorded.chatSessionFile) ? recorded.chatSessionFile : null;
    const { session, sessionFile } = await this.opts.factory({ sessionFile: reopen });
    this.attach(session, sessionFile);
    if (recorded?.chatSessionFile !== sessionFile) writeWorkspaceState(this.opts.stateDir, { chatSessionFile: sessionFile });
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
    const id = params.messageId;
    if (this.isSeen(id)) return DUPLICATE;
    const original = this.inFlight.get(id);
    if (original) return original.then(() => DUPLICATE);
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
    return this.enqueue(async () => {
      const session = this.session;
      if (!session) return { aborted: false };
      if (turnId !== undefined && this.run?.turnId !== turnId) return { aborted: false };
      const aborted = session.isStreaming;
      this.dropQueued(session);
      if (this.run) this.run.abortRequested = true;
      await session.abort();
      return { aborted };
    });
  }

  handleNew(): Promise<ChatNewResult> {
    return this.enqueue(async () => {
      this.resetting = true;
      try {
        const old = this.session;
        if (old) {
          this.dropQueued(old);
          this.retireContext();
          if (this.run) {
            this.run.abortRequested = true;
            this.run.suppressReply = true;
          }
          // Abort while still subscribed, so the retired run closes with turn_end{aborted}.
          if (old.isStreaming) await old.abort();
          // After the abort: a flush sent into a live run would join it as a steer.
          await this.flushBeforeNew(old);
        }
        // Build the replacement first: if that fails, the old session stays attached and usable.
        const { session, sessionFile } = await this.opts.factory({ sessionFile: null });
        this.detach();
        old?.dispose();
        this.attach(session, sessionFile);
        writeWorkspaceState(this.opts.stateDir, { chatSessionFile: sessionFile });
        log.info({ sessionFile }, "started a new chat session");
        return { sessionFile };
      } finally {
        this.resetting = false;
      }
    });
  }

  // The replacement session is built fresh from the home files, so it needs no reload.
  private async flushBeforeNew(old: ChatSession): Promise<void> {
    const memory = this.opts.memory;
    if (!memory) return;
    await this.turnCommit;
    if (hasConversation(old)) await this.flushMemory(old, "new");
    await this.commitMemory("memory: flush before new session");
  }

  /** Runs one hidden flush turn on `session`, bounded; call from inside the inbound chain so messages wait behind it. */
  private async flushMemory(session: ChatSession, reason: FlushReason): Promise<"done" | "timeout" | "skipped"> {
    await this.waitForCompaction();
    await this.waitForSettle();
    if (session !== this.session || session.isStreaming) return "skipped";
    const timeoutMs = this.opts.memory?.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.flushing = true;
    try {
      const outcome = await Promise.race([
        session.prompt(flushPrompt(reason), { expandPromptTemplates: false }).then(() => "done" as const),
        new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs))),
      ]);
      if (outcome === "timeout") {
        log.warn({ reason, timeoutMs }, "memory flush timed out; aborting it and carrying on");
        if (this.run?.hidden) this.run.abortRequested = true;
        await session.abort().catch((err) => log.warn({ err }, "aborting the timed-out memory flush failed"));
      } else {
        log.info({ reason }, "memory flushed");
      }
      return outcome;
    } catch (err) {
      if (isCompactionBusy(err)) log.info({ reason }, "memory flush skipped: compaction in progress");
      else log.warn({ err, reason }, "memory flush failed");
      return "skipped";
    } finally {
      clearTimeout(timer);
      this.flushing = false;
    }
  }

  private async commitMemory(message: string): Promise<void> {
    const memory = this.opts.memory;
    if (!memory) return;
    try {
      await memory.commit(message);
      this.memorySignature = memory.signature();
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
    const soft = trigger - (memory.flushMarginTokens ?? flushMarginTokens(usage.contextWindow));
    if (usage.tokens < soft || usage.tokens >= trigger) return;
    this.flushedThisCycle = true;
    const gen = this.generation;
    void this.enqueue(async () => {
      if (gen !== this.generation) return;
      // Settled first, so the turn's commit can't sweep up the flush's edits under its own message.
      await this.turnCommit;
      const outcome = await this.flushMemory(session, "compaction");
      if (outcome === "skipped") return;
      await this.commitMemory("memory: flush before compaction");
      if (gen !== this.generation || session.isStreaming) return;
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

  async dispose(): Promise<void> {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = null;
    const session = this.session;
    this.detach();
    if (session?.isStreaming) await session.abort().catch(() => {});
    session?.dispose();
    await this.turnCommit;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // Pi marks the run active only after async preflight, so gate the queue on preflightResult or a racing idle prompt starts a second run.
  private async promptOrSteer(messageId: string, text: string, origin: ChatOrigin | undefined): Promise<"prompt" | "steer"> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForCompaction();
      await this.waitForSettle();
      const session = this.requireSession();
      const mode = session.isStreaming ? "steer" : "prompt";
      // Context that arrived during the last run belongs before this prompt, not after its reply.
      if (mode === "prompt" && this.pendingContext.length) await this.flushPendingContext();
      // Registered before prompt(): Pi can drain a steer before it calls preflightResult.
      const pending: PendingInbound = { messageId, text, origin };
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
    this.lastInboundId = this.unconsumed[i].messageId || this.lastInboundId;
    this.lastOrigin = this.unconsumed[i].origin ?? this.lastOrigin;
    this.unconsumed.splice(0, i + 1);
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
    this.flushedThisCycle = false;
    this.session = session;
    this.sessionFile = sessionFile;
    this.unsubscribe = session.subscribe((event) => {
      if (gen === this.generation) this.onEvent(session, event);
    });
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.generation++;
    this.closeRunWithoutReply();
    this.releaseCompactionWaiters();
    this.releaseSettleWaiters();
  }

  private onEvent(session: ChatSession, event: AgentSessionEvent): void {
    if (event.type === "compaction_end") {
      if (event.result && !event.aborted) this.flushedThisCycle = false;
      this.releaseCompactionWaiters();
      return;
    }
    if (event.type === "message_start" && event.message.role === "user") {
      this.consumeInbound(userText(event.message));
    }
    if (event.type === "agent_start" && !this.run) {
      const prompt = this.nextRunPrompt;
      this.nextRunPrompt = undefined;
      this.run = {
        turnId: this.newId(),
        origin: prompt?.origin ?? this.lastOrigin,
        promptMessageId: prompt?.messageId || undefined,
        acc: newRunAccumulator(),
        deltaBuffer: "",
        deltaTimer: null,
        abortRequested: false,
        suppressReply: false,
        hidden: this.flushing,
      };
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
  }

  // turn_end.aborted means "no reply follows for this turn", so a reply suppressed by chat/new counts as aborted.
  private finishRun(session: ChatSession, run: OpenRun): SettleOutcome {
    if (run.hidden) return "suppressed";
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
      .request(RPC_METHODS.chatDeliver, entry)
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

function isCompactionBusy(err: unknown): boolean {
  return err instanceof Error && err.message.includes("while compaction is in progress");
}

function sameConversation(a: ChatOrigin | undefined, b: ChatOrigin | undefined): boolean {
  return a?.surface === b?.surface && a?.conversationId === b?.conversationId;
}
