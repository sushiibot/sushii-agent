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
  edit(options: MessageEditOptions): Promise<unknown>;
}

export interface DmChannelPort {
  send(options: MessageCreateOptions): Promise<EditableMessage>;
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
}

type ToolLine = { name: string; summary: string; state: "run" | "ok" | "err" };

interface TurnProgress {
  turnId: string;
  startedAt: number;
  lines: ToolLine[];
  toolCount: number;
  message: Promise<EditableMessage | null> | null;
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
  private rpc: WorkspaceRpc | null;

  constructor(opts: WorkspaceLinkOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.rpc = opts.rpc ?? null;
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

  async abort(): Promise<{ aborted: boolean }> {
    return (await this.request(RPC_METHODS.chatAbort, { principalId: this.opts.principalId }, CONTROL_TIMEOUT_MS)) as { aborted: boolean };
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
    if (this.replaying) return this.replaying;
    this.replaying = (async () => {
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
      } finally {
        this.replaying = null;
      }
    })();
    return this.replaying;
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
    // An idle workspace has no run in flight, so any turn still shown as working ended unobserved.
    if (conn.state === "idle") {
      for (const turn of [...this.turns.values()]) this.finishTurn(turn, "interrupted");
    }
    void this.replayInbox();
  }

  private async onRequest(conn: ConnectionInfo, method: string, params: unknown): Promise<unknown> {
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

  /** Renders a delivery once, then acks it. A failed Discord send is left unacked so the workspace resends it. */
  async deliver(p: ChatDeliverParams): Promise<void> {
    if (this.delivering.has(p.outboxId)) return;
    this.delivering.add(p.outboxId);
    try {
      if (!this.opts.store.hasSeenOutbox(p.outboxId)) {
        const channel = await this.opts.ownerChannel();
        if (!channel) throw new Error("owner DM channel unavailable");
        for (const msg of this.renderDelivery(p)) await channel.send(msg);
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

  renderDelivery(p: ChatDeliverParams): MessageCreateOptions[] {
    if (p.kind === "ask") return [this.renderAsk(p)];
    const prefix = p.kind === "proactive" ? "-# ⏰\n" : "";
    const footer = p.usage ? `\n${renderChatUsageFooter(p.usage)}` : "";
    return buildComponentMessages(`${prefix}${p.text}${footer}`).map((m) => ({ ...m, allowedMentions: { parse: [] } }));
  }

  private renderAsk(p: ChatDeliverParams): MessageCreateOptions {
    const question = p.ask?.question ?? p.text;
    const choices = (p.ask?.choices ?? []).slice(0, 25);
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
    const ev = p.ev;
    switch (ev.type) {
      case "turn_start":
        this.turnFor(p.turnId);
        return;
      case "tool_start": {
        const turn = this.turnFor(p.turnId);
        turn.lines.push({ name: ev.name, summary: ev.summary, state: "run" });
        turn.toolCount++;
        if (!turn.message) {
          turn.lastEditAt = this.now();
          turn.message = this.createMessage(this.renderWorking(turn));
          turn.chain = turn.message;
        } else {
          this.markDirty(turn);
        }
        return;
      }
      case "tool_end": {
        const turn = this.turns.get(p.turnId);
        const line = turn?.lines.find((l) => l.name === ev.name && l.state === "run");
        if (!turn || !line) return;
        line.state = ev.ok ? "ok" : "err";
        this.markDirty(turn);
        return;
      }
      case "turn_end": {
        const turn = this.turns.get(p.turnId);
        if (turn) this.finishTurn(turn, ev.aborted ? "stopped" : "done");
        else if (ev.aborted) {
          // A tool-less run that was stopped: no progress message exists, and no reply will follow.
          void this.createMessage(this.renderFinal({ startedAt: this.now(), toolCount: 0 }, "stopped"));
        }
        return;
      }
      case "text_delta":
        return;
    }
  }

  /** Waits for every queued progress edit; for tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.turns.values()].map((t) => t.chain.catch(() => {})));
  }

  private turnFor(turnId: string): TurnProgress {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { turnId, startedAt: this.now(), lines: [], toolCount: 0, message: null, chain: Promise.resolve(), lastEditAt: 0, timer: null };
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

  private finishTurn(turn: TurnProgress, outcome: Outcome): void {
    this.turns.delete(turn.turnId);
    if (turn.timer !== null) {
      this.timers.clear(turn.timer);
      turn.timer = null;
    }
    if (turn.message) void this.queueEdit(turn, () => this.renderFinal(turn, outcome));
    else if (outcome !== "done") void this.createMessage(this.renderFinal({ startedAt: turn.startedAt, toolCount: 0 }, outcome));
  }

  renderWorking(turn: Pick<TurnProgress, "turnId" | "startedAt" | "lines">): MessageCreateOptions & MessageEditOptions {
    const icon = { run: "…", ok: "✓", err: "✗" } as const;
    const lines = turn.lines.slice(-PROGRESS_LINES).map((l) => `${icon[l.state]} **${l.name}** ${l.summary}`.trimEnd());
    const header = `⏳ working · started <t:${Math.floor(turn.startedAt / 1000)}:R>`;
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

  renderFinal(turn: Pick<TurnProgress, "startedAt" | "toolCount">, outcome: Outcome): MessageCreateOptions & MessageEditOptions {
    const tools = `${turn.toolCount} ${turn.toolCount === 1 ? "tool" : "tools"}`;
    const summary = `${formatDuration(this.now() - turn.startedAt)} · ${tools}`;
    const [label, accent] =
      outcome === "done" ? [`✓ done · ${summary}`, ACCENT.info] : outcome === "stopped" ? [`⏹ stopped · ${summary}`, ACCENT.danger] : [`⚠️ interrupted · ${summary}`, ACCENT.warning];
    const container = new ContainerBuilder().setAccentColor(accent).addTextDisplayComponents(new TextDisplayBuilder({ content: label }));
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
  }
}

/** The ask message once answered: its question text with the choice noted, and no buttons. */
export function answeredAsk(message: { components: Array<{ toJSON(): unknown }> }, answer: string): MessageEditOptions {
  const texts: string[] = [];
  const walk = (node: unknown) => {
    const n = node as { type?: number; content?: unknown; components?: unknown[] };
    if (n?.type === ComponentType.TextDisplay && typeof n.content === "string") texts.push(n.content);
    n?.components?.forEach(walk);
  };
  message.components.forEach((c) => walk(c.toJSON()));
  const question = (texts[0] ?? "🙋 **Question**").split("\n-# ")[0];
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.success)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `${question}\n-# → ${answer}` }));
  return { components: [container], allowedMentions: { parse: [] } };
}
