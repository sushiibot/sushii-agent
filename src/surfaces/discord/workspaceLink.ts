import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import {
  RPC_METHODS,
  chatDeliverParams,
  chatEventParams,
  type ChatDeliverParams,
  type ChatEventParams,
  type ChatMessageParams,
  type ChatMessageResult,
  type ToolCallResult,
  type ToolManifestEntry,
} from "../../orchestration/contracts.ts";
import { MethodNotFoundError, type ConnectionInfo, type WorkspaceHandler } from "../../orchestration/transport/server.ts";
import type { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { getLogger } from "../../logger.ts";
import { buildComponentMessages } from "./delivery.ts";
import { renderChatUsageFooter } from "./footer.ts";

const log = getLogger("surfaces/discord/workspaceLink");

export const WS_STOP_PREFIX = "wsstop:";
export const WS_ASK_PREFIX = "wsask:";

export const ACCENT = { info: 0x5865f2, success: 0x23a55a, danger: 0xf23f43, warning: 0xf0b232 } as const;

export const OFFLINE_NOTICE = "-# ⚠️ workspace offline — answering without workspace tools";
export const MESSAGE_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 30_000;
const PROGRESS_LINES = 8;
const OUTBOX_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENDED_TURNS_KEPT = 100;
/** Consecutive failed sends of one delivery before it goes out as plain text instead. */
export const DELIVERY_MAX_FAILURES = 3;
const PLAIN_CHUNK = 2000;
const ASK_QUESTION_MAX = 3500;

/** Minimum gap between progress edits for a turn of the given age. */
export function progressEditGap(ageMs: number): number {
  if (ageMs < 30_000) return 3_000;
  if (ageMs < 120_000) return 10_000;
  if (ageMs < 600_000) return 30_000;
  return 60_000;
}

/** How long to wait before the next progress edit; 0 means edit now. */
export function progressEditDelay(input: { now: number; startedAt: number; lastEditAt: number }): number {
  const gap = progressEditGap(input.now - input.startedAt);
  return Math.max(0, input.lastEditAt + gap - input.now);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The slice of OrchestrationServer the link drives; tests supply a fake. */
export interface WorkspaceRpc {
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined;
  requestWorkspace(principalId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  setWorkspaceHandler(handler: WorkspaceHandler | null): void;
}

export interface EditableMessage {
  /** Needed to find a progress message again after a restart; without it the view isn't persisted. */
  id?: string;
  edit(options: MessageEditOptions): Promise<unknown>;
}

export interface DmChannelPort {
  send(options: MessageCreateOptions): Promise<EditableMessage>;
  /** Re-opens a message this bot sent earlier; resolves null when it's gone. */
  fetchMessage?(id: string): Promise<EditableMessage | null>;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface WorkspaceLinkOptions {
  principalId: string;
  /** Absent until attach(); without one the workspace is always offline. */
  rpc?: WorkspaceRpc | null;
  store: WorkspaceLinkStore;
  ownerChannel: () => Promise<DmChannelPort | null>;
  /** Author attached to replayed inbox context. */
  owner: () => { id: string; name: string };
  now?: () => number;
  timers?: Timers;
  /** Serves `tool/call` and the register result's tool manifest; absent → no tools offered. */
  tools?: WorkspaceToolsPort;
  /** DM_WORKSPACE_ENABLED. When false the link still drains a connected workspace's deliveries (say, a
   *  reply outboxed before a rollback) but offers and serves no tools. Default true. */
  enabled?: boolean;
}

export interface WorkspaceToolsPort {
  manifest(): ToolManifestEntry[];
  handleCall(conn: ConnectionInfo, params: unknown): Promise<ToolCallResult>;
  onSocketClosed(conn: ConnectionInfo): void;
}

const MAIN_AGENT = "main";
const PROGRESS_KV_PREFIX = "workspace:progress:";
const ENDED_COUNTS_PERSISTED = 20;

/** `agentId` is set on a subagent's tool, which renders nested under the parent turn. */
type ToolLine = { name: string; summary: string; state: "run" | "ok" | "err"; agentId?: string };

/** What survives a restart: open progress views (to finalize or keep driving) and recent tool counts. */
interface ProgressSnapshot {
  open: Array<{ turnId: string; messageId: string; startedAt: number; toolCount: number; lines: ToolLine[] }>;
  ended: Array<[string, number]>;
}

interface TurnProgress {
  turnId: string;
  startedAt: number;
  lines: ToolLine[];
  toolCount: number;
  message: Promise<EditableMessage | null> | null;
  messageId: string | null;
  /** Rebuilt from the snapshot of an earlier process. */
  restored: boolean;
  // Serializes edits so a late in-flight edit can't overwrite the terminal state.
  chain: Promise<unknown>;
  lastEditAt: number;
  timer: unknown;
}

type Outcome = "done" | "stopped" | "interrupted";

/** Bot side of the personal-agent workspace chat protocol: sends owner DMs to the workspace and
 *  renders its live progress and deliveries back into the owner's DM. */
export class WorkspaceLink {
  private readonly opts: WorkspaceLinkOptions;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly turns = new Map<string, TurnProgress>();
  private readonly delivering = new Set<string>();
  private readonly askChoices = new Map<string, string[]>();
  private connectWaiters: Array<() => void> = [];
  private replaying: Promise<void> | null = null;
  private replayAgain = false;
  // turnId → tool count for turns that have ended; null when the count is unknown (a restart).
  private readonly endedTurns = new Map<string, number | null>();
  private rpc: WorkspaceRpc | null;
  // Progress views an earlier process left open, picked up on the first register.
  private orphans: ProgressSnapshot["open"];
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

  /** Installs the server hooks; call before the orchestration server starts listening. */
  attach(rpc: WorkspaceRpc): void {
    this.rpc = rpc;
    rpc.setWorkspaceHandler(this.handler());
  }

  handler(): WorkspaceHandler {
    return {
      onRegister: (conn) => this.onRegister(conn),
      onDisconnect: (conn) => {
        if (conn.principalId === this.opts.principalId) log.info({ runnerId: conn.runnerId }, "workspace disconnected");
      },
      onSocketClosed: (conn) => this.opts.tools?.onSocketClosed(conn),
      toolManifest: (conn) => (conn.principalId === this.opts.principalId && this.toolsEnabled ? this.opts.tools!.manifest() : []),
      onRequest: (conn, method, params) => this.onRequest(conn, method, params),
      onNotification: (conn, method, params) => this.onNotification(conn, method, params),
    };
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
    const params: ChatMessageParams = { principalId: this.opts.principalId, ...input };
    return (await this.request(RPC_METHODS.chatMessage, params, MESSAGE_TIMEOUT_MS)) as ChatMessageResult;
  }

  /** With a turnId, the workspace aborts only that turn and answers aborted:false once it has ended. */
  async abort(turnId?: string): Promise<{ aborted: boolean }> {
    const params = { principalId: this.opts.principalId, ...(turnId ? { turnId } : {}) };
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

  async newSession(): Promise<{ sessionFile: string }> {
    return (await this.request(RPC_METHODS.chatNew, { principalId: this.opts.principalId }, CONTROL_TIMEOUT_MS)) as { sessionFile: string };
  }

  /** Records an exchange the in-process fallback answered, for replay into the workspace's history. */
  recordOffline(userText: string, replyText: string): void {
    this.opts.store.addInbox(this.opts.principalId, userText, replyText, this.now());
    // It may have connected while the fallback was answering, after this register's replay ran.
    if (this.isConnected()) void this.replayInbox();
  }

  /** Answer text for an ask button, from memory or (after a restart) the button's label. */
  askChoice(askId: string, index: number, label: string | null): string | null {
    return this.askChoices.get(askId)?.[index] ?? label;
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

  private onRegister(conn: ConnectionInfo): void {
    if (conn.principalId !== this.opts.principalId) return;
    log.info({ runnerId: conn.runnerId, state: conn.state }, "workspace registered");
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w();
    this.restoreOrphans(conn.state === "streaming");
    // An idle workspace has no run in flight, so any turn still shown as working ended unobserved.
    if (conn.state === "idle") {
      for (const turn of [...this.turns.values()]) this.finishTurn(turn, "interrupted");
    }
    void this.replayInbox();
  }

  /** Takes over the progress views an earlier process left open. Inserted synchronously so an event for
   *  the same turn edits the existing message instead of opening a second one. A restored view never
   *  sends a new message: when its message can't be fetched, its edits are dropped. */
  private restoreOrphans(streaming: boolean): void {
    const orphans = this.orphans;
    this.orphans = [];
    if (!orphans.length) return;
    const channel = this.opts.ownerChannel().catch(() => null);
    for (const o of orphans) {
      if (this.turns.has(o.turnId) || this.endedTurns.has(o.turnId)) continue;
      const message = channel.then((c) => c?.fetchMessage?.(o.messageId).catch(() => null) ?? null);
      const turn: TurnProgress = {
        turnId: o.turnId,
        startedAt: o.startedAt,
        lines: o.lines,
        toolCount: o.toolCount,
        message,
        messageId: o.messageId,
        restored: true,
        chain: message,
        lastEditAt: 0,
        timer: null,
      };
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
    const open = [...this.turns.values()]
      .filter((t) => t.messageId !== null)
      .map((t) => ({ turnId: t.turnId, messageId: t.messageId!, startedAt: t.startedAt, toolCount: t.toolCount, lines: t.lines.slice(-PROGRESS_LINES) }));
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
    if (method !== RPC_METHODS.chatDeliver) throw new MethodNotFoundError(`method not found: ${method}`);
    const p = chatDeliverParams.parse(params);
    if (p.principalId !== conn.principalId || p.principalId !== this.opts.principalId) throw new Error("principal mismatch");
    // Reply first; chat/ack confirms the Discord send separately.
    void this.deliver(p);
    return {};
  }

  private onNotification(conn: ConnectionInfo, method: string, params: unknown): void {
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

  /** Renders a delivery once, then acks it. A failed Discord send is left unacked so the workspace resends
   *  it; pages already sent are recorded and skipped on the resend. */
  async deliver(p: ChatDeliverParams): Promise<void> {
    if (this.delivering.has(p.outboxId)) return;
    this.delivering.add(p.outboxId);
    try {
      if (!this.opts.store.hasSeenOutbox(p.outboxId)) {
        const toolCount = p.kind === "reply" && p.turnId ? this.closeTurnForReply(p.turnId) : null;
        const channel = await this.opts.ownerChannel();
        if (!channel) throw new Error("owner DM channel unavailable");
        let pages: MessageCreateOptions[] | null = null;
        try {
          pages = this.renderDelivery(p, toolCount);
          for (const [i, page] of pages.entries()) {
            const pageKey = `${p.outboxId}#${i}`;
            if (pages.length > 1 && this.opts.store.hasSeenOutbox(pageKey)) continue;
            await channel.send(page);
            if (pages.length > 1) this.opts.store.markOutboxSeen(pageKey, p.principalId, this.now());
          }
          this.opts.store.deleteKv(failureKey(p.outboxId));
        } catch (err) {
          // Persisted: the workspace resends mostly after a register, which usually follows a bot restart.
          const failures = Number(this.opts.store.getKv(failureKey(p.outboxId)) ?? "0") + 1;
          this.opts.store.setKv(failureKey(p.outboxId), String(failures));
          if (failures < DELIVERY_MAX_FAILURES) throw err;
          log.warn({ err, outboxId: p.outboxId, failures }, "delivery keeps failing to render; sending it as plain text");
          const fullText = p.kind === "ask" ? (p.ask?.question ?? p.text) : p.text;
          // Pages that already went out as components aren't repeated.
          const text = pages && pages.length > 1 ? this.unsentPagesText(pages, p.outboxId) : fullText;
          for (const chunk of plainChunks(text)) {
            await channel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
          this.opts.store.deleteKv(failureKey(p.outboxId));
        }
        this.opts.store.markOutboxSeen(p.outboxId, p.principalId, this.now());
      }
      await this.request(RPC_METHODS.chatAck, { outboxId: p.outboxId }, CONTROL_TIMEOUT_MS).catch((err) =>
        log.warn({ err, outboxId: p.outboxId }, "chat/ack failed; the workspace will resend and be re-acked"),
      );
    } catch (err) {
      log.warn({ err, outboxId: p.outboxId }, "failed to deliver workspace message");
    } finally {
      this.delivering.delete(p.outboxId);
    }
  }

  private unsentPagesText(pages: MessageCreateOptions[], outboxId: string): string {
    return pages
      .filter((_, i) => !this.opts.store.hasSeenOutbox(`${outboxId}#${i}`))
      .map((page) => textDisplays(page.components ?? []).join("\n"))
      .join("\n");
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
      void this.queueEdit(restored, () => this.renderFinal(restored, "done"));
    }
    return this.endedTurns.get(turnId) ?? null;
  }

  renderDelivery(p: ChatDeliverParams, toolCount: number | null = null): MessageCreateOptions[] {
    if (p.kind === "ask") return [this.renderAsk(p)];
    const prefix = p.kind === "proactive" ? "-# ⏰\n" : "";
    const tools = toolCount ? toolsLabel(toolCount) : null;
    const footerLine = p.usage ? `${renderChatUsageFooter(p.usage)}${tools ? ` · ${tools}` : ""}` : tools ? `-# ${tools}` : null;
    const footer = footerLine ? `\n${footerLine}` : "";
    return buildComponentMessages(`${prefix}${p.text}${footer}`).map((m) => ({ ...m, allowedMentions: { parse: [] } }));
  }

  private renderAsk(p: ChatDeliverParams): MessageCreateOptions {
    const rawQuestion = p.ask?.question ?? p.text;
    const question = rawQuestion.length > ASK_QUESTION_MAX ? `${rawQuestion.slice(0, ASK_QUESTION_MAX)}…` : rawQuestion;
    const choices = (p.ask?.choices ?? []).slice(0, 25).map((c, i) => (c.trim() ? c : `(option ${i + 1})`));
    const container = new ContainerBuilder()
      .setAccentColor(ACCENT.info)
      .addTextDisplayComponents(
        new TextDisplayBuilder({ content: `🙋 **Question**\n${question}\n-# ${choices.length ? "Pick an option or reply here." : "Reply here to answer."}` }),
      );
    if (p.ask && choices.length) {
      this.askChoices.set(p.ask.askId, choices);
      for (let i = 0; i < choices.length; i += 5) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        choices.slice(i, i + 5).forEach((choice, j) =>
          row.addComponents(
            new ButtonBuilder().setCustomId(`${WS_ASK_PREFIX}${p.ask!.askId}:${i + j}`).setLabel(choice.slice(0, 80)).setStyle(ButtonStyle.Secondary),
          ),
        );
        container.addActionRowComponents(row);
      }
    }
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
  }

  // ── Live progress ──────────────────────────────────────────────────────────

  onEvent(p: ChatEventParams): void {
    if (p.agentId !== MAIN_AGENT) {
      this.onSubagentEvent(p);
      return;
    }
    const ev = p.ev;
    switch (ev.type) {
      case "turn_start":
        // One main turn runs at a time, so a restored view of another turn ended while the bot was down.
        for (const turn of [...this.turns.values()]) if (turn.restored && turn.turnId !== p.turnId) this.finishTurn(turn, "interrupted");
        this.turnFor(p.turnId);
        return;
      case "tool_start":
        this.addToolLine(this.turnFor(p.turnId), { name: ev.name, summary: ev.summary, state: "run" });
        return;
      case "tool_end":
        this.endToolLine(this.turns.get(p.turnId), ev.name, ev.ok, undefined);
        return;
      case "turn_end": {
        const turn = this.turns.get(p.turnId);
        if (turn) this.finishTurn(turn, ev.aborted ? "stopped" : "done");
        else if (ev.aborted && !this.endedTurns.has(p.turnId)) {
          // A tool-less run that was stopped: no progress message exists, and no reply will follow.
          void this.createMessage(this.renderFinal({ startedAt: this.now(), toolCount: 0 }, "stopped"));
        }
        return;
      }
      case "text_delta":
        return;
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
    if (p.ev.type === "tool_start") this.addToolLine(turn, { name: p.ev.name, summary: p.ev.summary, state: "run", agentId: p.agentId });
    else if (p.ev.type === "tool_end") this.endToolLine(turn, p.ev.name, p.ev.ok, p.agentId);
  }

  private addToolLine(turn: TurnProgress, line: ToolLine): void {
    turn.lines.push(line);
    turn.toolCount++;
    if (!turn.message) {
      turn.lastEditAt = this.now();
      turn.message = this.createMessage(this.renderWorking(turn));
      turn.chain = turn.message;
      void turn.message.then((m) => {
        turn.messageId = m?.id ?? null;
        if (this.turns.get(turn.turnId) === turn) this.persistProgress();
      });
    } else {
      this.markDirty(turn);
      this.persistProgress();
    }
  }

  private endToolLine(turn: TurnProgress | undefined, name: string, ok: boolean, agentId: string | undefined): void {
    const line = turn?.lines.find((l) => l.name === name && l.agentId === agentId && l.state === "run");
    if (!turn || !line) return;
    line.state = ok ? "ok" : "err";
    this.markDirty(turn);
    this.persistProgress();
  }

  /** Waits for every queued progress edit; for tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.turns.values()].map((t) => t.chain.catch(() => {})));
  }

  private turnFor(turnId: string): TurnProgress {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { turnId, startedAt: this.now(), lines: [], toolCount: 0, message: null, messageId: null, restored: false, chain: Promise.resolve(), lastEditAt: 0, timer: null };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private async createMessage(options: MessageCreateOptions): Promise<EditableMessage | null> {
    try {
      const channel = await this.opts.ownerChannel();
      return channel ? await channel.send(options) : null;
    } catch (err) {
      log.warn({ err }, "failed to send workspace progress message");
      return null;
    }
  }

  private markDirty(turn: TurnProgress): void {
    if (turn.timer !== null) return; // coalesced into the pending edit
    const delay = progressEditDelay({ now: this.now(), startedAt: turn.startedAt, lastEditAt: turn.lastEditAt });
    if (delay === 0) {
      this.queueEdit(turn, () => this.renderWorking(turn));
      return;
    }
    turn.timer = this.timers.set(() => {
      turn.timer = null;
      if (this.turns.get(turn.turnId) === turn) this.queueEdit(turn, () => this.renderWorking(turn));
    }, delay);
  }

  private queueEdit(turn: TurnProgress, render: () => MessageEditOptions): Promise<unknown> {
    turn.lastEditAt = this.now();
    const message = turn.message;
    turn.chain = turn.chain.then(async () => {
      const msg = await message;
      if (msg) await msg.edit(render()).catch((err) => log.warn({ err, turnId: turn.turnId }, "failed to edit workspace progress"));
    });
    return turn.chain;
  }

  private rememberEnded(turnId: string, toolCount: number | null): void {
    this.endedTurns.delete(turnId);
    this.endedTurns.set(turnId, toolCount);
    if (this.endedTurns.size > ENDED_TURNS_KEPT) this.endedTurns.delete(this.endedTurns.keys().next().value!);
  }

  private finishTurn(turn: TurnProgress, outcome: Outcome): void {
    this.turns.delete(turn.turnId);
    this.rememberEnded(turn.turnId, turn.toolCount);
    if (turn.timer !== null) {
      this.timers.clear(turn.timer);
      turn.timer = null;
    }
    if (turn.message) void this.queueEdit(turn, () => this.renderFinal(turn, outcome));
    else if (outcome !== "done") void this.createMessage(this.renderFinal({ startedAt: turn.startedAt, toolCount: 0 }, outcome));
    this.persistProgress();
  }

  renderWorking(turn: Pick<TurnProgress, "turnId" | "startedAt" | "lines">): MessageCreateOptions & MessageEditOptions {
    const icon = { run: "…", ok: "✓", err: "✗" } as const;
    const lines = turn.lines.slice(-PROGRESS_LINES).map((l) => `${l.agentId ? "↳ " : ""}${icon[l.state]} \`${l.name}\` ${l.summary}`.trimEnd());
    const header = `-# ⏳ working · started <t:${Math.floor(turn.startedAt / 1000)}:R>`;
    const container = new ContainerBuilder()
      .setAccentColor(ACCENT.info)
      .addTextDisplayComponents(new TextDisplayBuilder({ content: [header, ...lines].join("\n") }))
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${WS_STOP_PREFIX}${turn.turnId}`).setLabel("Stop").setStyle(ButtonStyle.Secondary),
        ),
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
  }

  /** Pass null for a turn this process no longer tracks: the label then carries no duration or count. */
  renderFinal(turn: Pick<TurnProgress, "startedAt" | "toolCount"> | null, outcome: Outcome): MessageCreateOptions & MessageEditOptions {
    const summary = turn ? ` · ${formatDuration(this.now() - turn.startedAt)} · ${toolsLabel(turn.toolCount)}` : "";
    const [label, accent] =
      outcome === "done" ? [`✓ done${summary}`, ACCENT.info] : outcome === "stopped" ? [`⏹ stopped${summary}`, ACCENT.danger] : [`⚠️ interrupted${summary}`, ACCENT.warning];
    const container = new ContainerBuilder().setAccentColor(accent).addTextDisplayComponents(new TextDisplayBuilder({ content: label }));
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
  }
}

function failureKey(outboxId: string): string {
  return `workspace:deliver_failures:${outboxId}`;
}

function toolsLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function plainChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += PLAIN_CHUNK) chunks.push(text.slice(i, i + PLAIN_CHUNK));
  return chunks.length ? chunks : ["(empty message)"];
}

/** The text display contents of a message's components, in order. */
function textDisplays(components: readonly unknown[]): string[] {
  const texts: string[] = [];
  const walk = (node: unknown) => {
    const n = node as { type?: number; content?: unknown; components?: unknown[] };
    if (n?.type === ComponentType.TextDisplay && typeof n.content === "string") texts.push(n.content);
    n?.components?.forEach(walk);
  };
  for (const c of components) walk(typeof (c as { toJSON?: unknown }).toJSON === "function" ? (c as { toJSON(): unknown }).toJSON() : c);
  return texts;
}

/** The ask message once answered: its question text with the choice noted, and no buttons. */
export function answeredAsk(message: { components: Array<{ toJSON(): unknown }> }, answer: string): MessageEditOptions {
  const texts = textDisplays(message.components);
  const question = (texts[0] ?? "🙋 **Question**").split("\n-# ")[0];
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.success)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `${question}\n-# → ${answer}` }));
  return { components: [container], allowedMentions: { parse: [] } };
}
