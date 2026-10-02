import { existsSync } from "node:fs";
import { readWorkspaceState } from "./state.ts";
import { join } from "node:path";
import { z } from "zod";
import {
  RPC_METHODS,
  TOPIC_ID_RE,
  topicsManageParams,
  chatMessageParams,
  chatAbortParams,
  chatNewParams,
  chatCommandParams,
  chatAckParams,
  type ChatOrigin,
} from "../orchestration/contracts.ts";
import { Outbox } from "./outbox.ts";
import { readJson, writeFileAtomic } from "./files.ts";
import type { PersonalSession } from "./personalSession.ts";

export type TopicSession = Pick<
  PersonalSession,
  | "start"
  | "onRegistered"
  | "handleMessage"
  | "dispose"
  | "handlers"
  | "isIdle"
  | "prepareArchive"
  | "compactNow"
  | "currentTurnId"
  | "state"
  | "wake"
  | "ownsDelivery"
  | "hasUnackedDeliveries"
  | "requestContextReload"
>;

interface TopicRecord {
  id: string;
  title: string;
  brief: string;
  archived: boolean;
}

/** Main keeps its existing session; topics own separate state, dedupe and delivery outboxes. */
export class TopicSessions {
  private readonly sessions = new Map<string, TopicSession>();
  private readonly starting = new Map<string, Promise<TopicSession>>();
  private readonly records: Record<string, TopicRecord>;
  private changing: Promise<unknown> = Promise.resolve();
  private features: readonly string[] = [];
  constructor(
    private readonly opts: {
      principalId: string;
      stateDir: string;
      main: TopicSession;
      create(id: string): TopicSession;
      command: (p: unknown) => Promise<unknown>;
    },
  ) {
    const saved = z
      .record(
        z.object({
          id: z.string().regex(TOPIC_ID_RE),
          title: z.string().min(1).max(120),
          brief: z.string().max(16000),
          archived: z.boolean(),
        }),
      )
      .safeParse(readJson<unknown>(this.path) ?? {});
    if (!saved.success) throw new Error("invalid persisted topic catalog");
    this.records = Object.assign(
      Object.create(null) as Record<string, TopicRecord>,
      saved.data,
    );
  }
  private get path() {
    return join(this.opts.stateDir, "topics.json");
  }
  private save() {
    writeFileAtomic(this.path, JSON.stringify(this.records));
  }
  private id(origin?: ChatOrigin): string | null {
    if (origin?.surface !== "web" || origin.conversationId === "main")
      return null;
    const id = origin.conversationId;
    if (!TOPIC_ID_RE.test(id) || !this.records[id])
      throw new Error("unknown topic conversation");
    return id;
  }
  async session(origin?: ChatOrigin): Promise<TopicSession> {
    await this.changing;
    const id = this.id(origin);
    if (!id) return this.opts.main;
    if (this.records[id]!.archived) {
      this.records[id]!.archived = false;
      this.save();
    }
    return this.open(id);
  }
  private open(id: string): Promise<TopicSession> {
    const live = this.sessions.get(id);
    if (live) return Promise.resolve(live);
    const pending = this.starting.get(id);
    if (pending) return pending;
    const start = (async () => {
      const session = this.opts.create(id);
      try {
        const hadTranscript = existsSync(
          readWorkspaceState(join(this.opts.stateDir, "topics", id))
            ?.chatSessionFile ?? "",
        );
        await session.start();
        const record = this.records[id]!;
        if (!hadTranscript)
          await session.handleMessage({
            principalId: this.opts.principalId,
            origin: { surface: "web", conversationId: id },
            messageId: `topic-brief:${id}`,
            text: `Topic: ${record.title}\nInitial context:\n${record.brief}\nThis is an ongoing topic conversation. Continue its existing workstream across visits. Shared workspace files are available; other conversations have separate transcripts.`,
            kind: "context",
            author: { id: "workspace", name: "Main" },
          });
        session.onRegistered(this.features);
        this.sessions.set(id, session);
        return session;
      } catch (err) {
        await session.dispose();
        throw err;
      } finally {
        this.starting.delete(id);
      }
    })();
    this.starting.set(id, start);
    return start;
  }
  async restore(): Promise<void> {
    // Archived sessions may still have unacked deliveries; restore them too for outbox replay.
    for (const [id, record] of Object.entries(this.records))
      if (
        TOPIC_ID_RE.test(id) &&
        (!record.archived ||
          new Outbox(join(this.opts.stateDir, "topics", id)).unacked().length)
      )
        await this.open(id);
  }
  onRegistered(features: readonly string[]) {
    this.features = features;
    this.opts.main.onRegistered(features);
    for (const s of this.sessions.values()) s.onRegistered(features);
  }
  manage(p: unknown): Promise<unknown> {
    const next = this.changing.then(() => this.manageNow(p));
    this.changing = next.catch(() => {});
    return next;
  }
  private async manageNow(p: unknown) {
    const q = topicsManageParams.parse(p);
    if (q.principalId !== this.opts.principalId)
      throw new Error("principal mismatch");
    if (q.id === "main") throw new Error("Main is not a topic");
    const existing = this.records[q.id];
    if (q.action === "create") {
      if (existing) return { ok: true };
      if (!q.title) throw new Error("title required");
      this.records[q.id] = {
        id: q.id,
        title: q.title,
        brief: q.brief ?? "",
        archived: false,
      };
      this.save();
      try {
        await this.open(q.id);
      } catch (err) {
        delete this.records[q.id];
        this.save();
        throw err;
      }
    } else {
      if (!existing) throw new Error("unknown topic");
      const s = await this.open(q.id);
      if (q.action === "close" && !s.isIdle())
        throw new Error("Stop the thread's work before archiving it.");
      if (q.action === "close" && !existing.archived) {
        // Keep the transcript and save memory before archiving.
        await s.prepareArchive();
      }
      existing.archived = q.action === "close";
      this.save();
    }
    await this.retireArchived();
    return { ok: true };
  }
  private async retireArchived() {
    for (const [id, s] of this.sessions)
      if (
        this.records[id]?.archived &&
        s.isIdle() &&
        !s.hasUnackedDeliveries()
      ) {
        this.sessions.delete(id);
        await s.dispose();
      }
  }
  handlers(): Record<string, (p: unknown) => Promise<unknown>> {
    return {
      [RPC_METHODS.topicsManage]: (p) => this.manage(p),
      [RPC_METHODS.chatMessage]: async (p) => {
        const q = chatMessageParams.parse(p);
        if (q.principalId !== this.opts.principalId)
          throw new Error("principal mismatch");
        return (await this.session(q.origin)).handlers()[
          RPC_METHODS.chatMessage
        ]!(q);
      },
      [RPC_METHODS.chatNew]: async (p) => {
        const q = chatNewParams.parse(p);
        if (q.principalId !== this.opts.principalId)
          throw new Error("principal mismatch");
        return (await this.session(q.origin)).handlers()[RPC_METHODS.chatNew]!(
          q,
        );
      },
      [RPC_METHODS.chatAbort]: async (p) => {
        const q = chatAbortParams.parse(p);
        if (q.principalId !== this.opts.principalId)
          throw new Error("principal mismatch");
        if (q.origin)
          return (await this.session(q.origin)).handlers()[
            RPC_METHODS.chatAbort
          ]!(q);
        if (q.turnId) {
          const s = [this.opts.main, ...this.sessions.values()].find(
            (s) => s.currentTurnId() === q.turnId,
          );
          return s
            ? s.handlers()[RPC_METHODS.chatAbort]!(q)
            : { aborted: false };
        }
        return this.opts.main.handlers()[RPC_METHODS.chatAbort]!(q);
      },
      [RPC_METHODS.chatAck]: async (p) => {
        chatAckParams.parse(p);
        const { outboxId } = chatAckParams.parse(p);
        for (const s of [this.opts.main, ...this.sessions.values()])
          if (s.ownsDelivery(outboxId))
            await s.handlers()[RPC_METHODS.chatAck]!(p);
        await this.retireArchived();
        return {};
      },
      [RPC_METHODS.chatCommand]: async (p) => {
        const q = chatCommandParams.parse(p);
        if (q.principalId !== this.opts.principalId)
          throw new Error("principal mismatch");
        if (q.origin && this.id(q.origin) && q.command === "compact") {
          const r = await (await this.session(q.origin)).compactNow();
          return {
            text:
              "error" in r
                ? `Didn't compact: ${r.error}`
                : `Compacted: ${r.tokensBefore} → ${r.tokensAfter ?? "?"} tokens.`,
          };
        }
        return this.opts.command(q);
      },
    };
  }
  isIdle(): boolean {
    return [this.opts.main, ...this.sessions.values()].every((s) => s.isIdle());
  }
  requestContextReload() {
    for (const s of [this.opts.main, ...this.sessions.values()])
      s.requestContextReload();
  }
  get state(): "streaming" | "idle" {
    return [this.opts.main, ...this.sessions.values()].some(
      (s) => s.state === "streaming",
    )
      ? "streaming"
      : "idle";
  }
  wake(w: Parameters<PersonalSession["wake"]>[0]) {
    const id = this.id(w.origin);
    (id ? this.sessions.get(id) : this.opts.main)?.wake(w);
  }
  async dispose() {
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
  }
}
