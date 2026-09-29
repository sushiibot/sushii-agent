import { existsSync } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  RPC_METHODS,
  chatAckParams,
  chatMessageParams,
  type ChatAbortResult,
  type ChatDeliverParams,
  type ChatEventPayload,
  type ChatMessageParams,
  type ChatMessageResult,
  type ChatNewResult,
} from "../orchestration/contracts.ts";
import { ulid } from "./ulid.ts";
import { getLogger } from "../logger.ts";
import { mapSessionEvent, newRunAccumulator, replyText, runUsage, type RunAccumulator } from "./events.ts";
import { Outbox } from "./outbox.ts";
import { RecentIds } from "./recentIds.ts";
import { readWorkspaceState, writeWorkspaceState } from "./state.ts";

const log = getLogger("workspace.session");

export const VOICE_PREFIX = "[voice message, transcribed] ";
const CONTEXT_CUSTOM_TYPE = "workspace_context";

/** The slice of Pi's AgentSession the host drives; tests supply a fake. */
export type ChatSession = Pick<
  AgentSession,
  "isStreaming" | "isCompacting" | "pendingMessageCount" | "prompt" | "abort" | "subscribe" | "sendCustomMessage" | "getContextUsage" | "dispose"
>;

/** Opens `sessionFile` when given, else creates a fresh chat session. */
export type ChatSessionFactory = (input: { sessionFile: string | null }) => Promise<{ session: ChatSession; sessionFile: string }>;

export interface ChatTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
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
}

interface OpenRun {
  turnId: string;
  acc: RunAccumulator;
  deltaBuffer: string;
  deltaTimer: ReturnType<typeof setTimeout> | null;
}

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
  private pendingContext: string[] = [];
  private compactionWaiters: Array<() => void> = [];

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
      [RPC_METHODS.chatMessage]: (p) => this.handleMessage(chatMessageParams.parse(p)),
      [RPC_METHODS.chatAbort]: () => this.handleAbort(),
      [RPC_METHODS.chatNew]: () => this.handleNew(),
      [RPC_METHODS.chatAck]: async (p) => this.handleAck(chatAckParams.parse(p).outboxId),
    };
  }

  async handleMessage(params: ChatMessageParams): Promise<ChatMessageResult> {
    if (this.recentIds.has(params.messageId)) return { accepted: true, mode: "duplicate" };
    // Recorded before queueing so a resend while this one is held still counts as a duplicate.
    this.recentIds.add(params.messageId);
    try {
      if (params.kind === "context") {
        await this.enqueue(() => this.appendContext(params.text));
        return { accepted: true, mode: "context" };
      }
      const mode = await this.enqueue(() => this.promptOrSteer(params.messageId, formatUserText(params)));
      return { accepted: true, mode };
    } catch (err) {
      this.recentIds.delete(params.messageId); // not taken: let the bot's retry through
      throw err;
    }
  }

  async handleAbort(): Promise<ChatAbortResult> {
    const session = this.session;
    if (!session) return { aborted: false };
    const aborted = session.isStreaming;
    if (this.run) this.run.acc.aborted = true;
    await session.abort();
    return { aborted };
  }

  handleNew(): Promise<ChatNewResult> {
    return this.enqueue(async () => {
      this.resetting = true;
      try {
        await this.beforeNewSession();
        const old = this.session;
        // Abort while still subscribed, so the retired run closes with turn_end{aborted}.
        if (old?.isStreaming) await old.abort();
        this.detach();
        old?.dispose();
        const { session, sessionFile } = await this.opts.factory({ sessionFile: null });
        this.attach(session, sessionFile);
        writeWorkspaceState(this.opts.stateDir, { chatSessionFile: sessionFile });
        log.info({ sessionFile }, "started a new chat session");
        return { sessionFile };
      } finally {
        this.resetting = false;
      }
    });
  }

  /** Hook point for flushing memory before a reset; the flush turn lands in a later unit. */
  protected async beforeNewSession(): Promise<void> {}

  handleAck(outboxId: string): Record<string, never> {
    if (!this.outbox.ack(outboxId)) log.debug({ outboxId }, "ack for an unknown or already-acked outbox entry");
    return {};
  }

  /** Called after every (re)register: the bot dedupes by outboxId, so resending is safe. */
  resendUnacked(): void {
    for (const entry of this.outbox.unacked()) this.send(entry);
  }

  async dispose(): Promise<void> {
    const session = this.session;
    this.detach();
    if (session?.isStreaming) await session.abort().catch(() => {});
    session?.dispose();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // Pi marks the run active only after async preflight, so gate the queue on preflightResult or a racing idle prompt starts a second run.
  private async promptOrSteer(messageId: string, text: string): Promise<"prompt" | "steer"> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForCompaction();
      const session = this.requireSession();
      const mode = session.isStreaming ? "steer" : "prompt";
      try {
        await new Promise<void>((resolve, reject) => {
          session
            .prompt(text, {
              streamingBehavior: "steer",
              preflightResult: (ok) => {
                if (!ok) return;
                this.lastInboundId = messageId;
                resolve();
              },
            })
            .then(resolve, (err) => {
              reject(err);
              log.error({ err, messageId }, "chat prompt failed");
            });
        });
        return mode;
      } catch (err) {
        if (attempt === 0 && isCompactionBusy(err)) continue;
        throw err;
      }
    }
  }

  // Mid-run, sendCustomMessage(triggerTurn:false) would mutate the live message list; wait for settle.
  private async appendContext(text: string): Promise<void> {
    const session = this.requireSession();
    if (session.isStreaming || this.run) {
      this.pendingContext.push(text);
      return;
    }
    await session.sendCustomMessage({ customType: CONTEXT_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: false });
  }

  private async flushPendingContext(session: ChatSession): Promise<void> {
    const texts = this.pendingContext;
    this.pendingContext = [];
    for (const text of texts) {
      await session.sendCustomMessage({ customType: CONTEXT_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: false });
    }
  }

  private waitForCompaction(): Promise<void> {
    if (!this.session?.isCompacting) return Promise.resolve();
    return new Promise((resolve) => this.compactionWaiters.push(resolve));
  }

  private requireSession(): ChatSession {
    if (!this.session) throw new Error("personal session not started");
    return this.session;
  }

  private attach(session: ChatSession, sessionFile: string): void {
    const gen = ++this.generation;
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
  }

  private onEvent(session: ChatSession, event: AgentSessionEvent): void {
    if (event.type === "compaction_end") {
      this.releaseCompactionWaiters();
      return;
    }
    if (event.type === "agent_start" && !this.run) {
      this.run = { turnId: this.newId(), acc: newRunAccumulator(), deltaBuffer: "", deltaTimer: null };
      this.emit({ type: "turn_start" });
      return;
    }
    if (event.type === "agent_settled") {
      void this.settle(session);
      return;
    }
    const run = this.run;
    if (!run) return;
    for (const ev of mapSessionEvent(event, run.acc)) {
      if (ev.type === "text_delta") this.bufferDelta(run, ev.text);
      else this.emit(ev);
    }
  }

  private async settle(session: ChatSession): Promise<void> {
    const run = this.run;
    this.run = null;
    if (run) {
      this.flushDelta(run);
      this.emitFor(run, { type: "turn_end", aborted: run.acc.aborted });
      if (session.pendingMessageCount > 0 || session.isCompacting) {
        log.warn({ turnId: run.turnId, pending: session.pendingMessageCount }, "agent_settled with queued work; delivering anyway");
      }
      const text = replyText(run.acc);
      if (text !== null) {
        const entry: ChatDeliverParams = {
          outboxId: this.newId(),
          principalId: this.opts.principalId,
          kind: "reply",
          text,
          ...(this.lastInboundId ? { replyTo: this.lastInboundId } : {}),
          usage: runUsage(run.acc, this.opts.model, session.getContextUsage()?.percent),
        };
        this.outbox.append(entry);
        this.send(entry);
      }
    }
    if (this.pendingContext.length) {
      await this.flushPendingContext(session).catch((err) => log.error({ err }, "failed to append buffered context"));
    }
  }

  private send(entry: ChatDeliverParams): void {
    this.opts.transport
      .request(RPC_METHODS.chatDeliver, entry)
      .catch((err) => log.warn({ err, outboxId: entry.outboxId }, "chat/deliver not confirmed; will resend after re-register"));
  }

  private emit(ev: ChatEventPayload): void {
    if (this.run) this.emitFor(this.run, ev);
  }

  private emitFor(run: OpenRun, ev: ChatEventPayload): void {
    this.opts.transport.notify(RPC_METHODS.chatEvent, { principalId: this.opts.principalId, turnId: run.turnId, agentId: "main", ev });
  }

  private bufferDelta(run: OpenRun, text: string): void {
    const ms = this.opts.textDeltaMs === undefined ? 500 : this.opts.textDeltaMs;
    if (ms === null) return;
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
    if (run?.deltaTimer) clearTimeout(run.deltaTimer);
  }

  private releaseCompactionWaiters(): void {
    const waiters = this.compactionWaiters;
    this.compactionWaiters = [];
    for (const w of waiters) w();
  }
}

export function formatUserText(params: Pick<ChatMessageParams, "text" | "voice" | "attachments">): string {
  let text = params.voice ? `${VOICE_PREFIX}${params.text}` : params.text;
  // The workspace model is text-only; attachments reach it as links it can fetch with its tools.
  for (const a of params.attachments ?? []) text += `\n[attachment: ${a.name} (${a.contentType}) ${a.url}]`;
  return text;
}

function isCompactionBusy(err: unknown): boolean {
  return err instanceof Error && err.message.includes("while compaction is in progress");
}
