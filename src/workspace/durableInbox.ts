import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type Session } from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ChatOrigin } from "../orchestration/contracts.ts";
import { DurableState } from "../agentRuntime/durableState.ts";
import { readJson } from "./files.ts";

export type DurableInput = {
  messageId: string;
  text: string;
  origin?: ChatOrigin;
  images?: { [K in keyof ImageContent]: ImageContent[K] }[];
};

// Pi owns transactions, document checkpoints, and storage. This document only describes the
// application's admission boundary; execution still belongs to the coding-agent session.
const Inbox = defineDocFamily({
  kind: "sushii.inbox",
  version: 1,
  scope: "session",
  family: true,
  initial: (receipts: string[]) => ({ receipts, pending: [] as DurableInput[] }),
});

/** Conversation-scoped admission data in the process-wide Durable store. */
export class DurableInbox {
  private session: Session | undefined;
  private opening: Promise<void> | undefined;
  private readonly receipts = new Set<string>();
  private readonly queued = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private failure: unknown;
  private readonly store: DurableState;
  private readonly ownsStore: boolean;
  private readonly key: string;

  constructor(private readonly stateDir: string, private readonly capacity = 500, options: { store?: DurableState; conversationId?: string } = {}) {
    this.store = options.store ?? new DurableState(stateDir);
    this.ownsStore = !options.store;
    this.key = options.conversationId ?? "main";
  }

  async open(): Promise<void> {
    this.opening ??= this.load();
    await this.opening;
  }

  private async load(): Promise<void> {
    const session = await this.store.open();
    try {
      if (!(await session.snapshot(Inbox, this.key, BACKGROUND_CONTEXT))) {
        const legacy = readJson<unknown>(join(this.stateDir, "recent-ids.json"));
        await session.commit(async (tx) => {
          const receipts = Array.isArray(legacy) ? legacy.filter((id): id is string => typeof id === "string").slice(-this.capacity) : [];
          await tx.doc(Inbox, this.key, receipts);
        }, BACKGROUND_CONTEXT);
      }
      const inbox = (await session.snapshot(Inbox, this.key, BACKGROUND_CONTEXT))!;
      for (const id of inbox.receipts) this.receipts.add(id);
      for (const input of inbox.pending) this.queued.add(input.messageId);
      this.session = session;
    } catch (err) {
      if (this.ownsStore) await this.store.close();
      throw err;
    }
  }

  has(id: string): boolean {
    return this.receipts.has(id) || this.queued.has(id);
  }

  /** Save a fully prepared input before handing it to Pi, including queued steers. */
  async prepare(input: DurableInput): Promise<void> {
    if (!input.messageId) return;
    // Drop optional undefined values: Durable documents are JSON, and retain image bytes locally.
    const saved = JSON.parse(JSON.stringify(input)) as DurableInput;
    this.change(async (session) => {
      await session.commit(async (tx) => {
        const doc = await tx.doc(Inbox, this.key, []);
        const existing = doc.pending.findIndex((p) => p.messageId === saved.messageId);
        if (existing < 0) doc.pending.push(saved);
        else doc.pending[existing] = saved;
      }, BACKGROUND_CONTEXT);
    });
    await this.flush();
    this.queued.add(saved.messageId);
  }

  add(id: string): void {
    if (!id || this.receipts.has(id)) return;
    this.receipts.add(id);
    if (this.receipts.size > this.capacity) this.receipts.delete(this.receipts.values().next().value!);
    this.change(async (session) => {
      await session.commit(async (tx) => {
        const doc = await tx.doc(Inbox, this.key, []);
        if (!doc.receipts.includes(id)) doc.receipts.push(id);
        doc.receipts = doc.receipts.slice(-this.capacity);
      }, BACKGROUND_CONTEXT);
    });
  }

  /** Once Pi consumes an input, it must never be replayed across its tool side effects. */
  consume(ids: readonly string[], accepted = true): void {
    const selected = new Set(ids.filter(Boolean));
    if (!selected.size) return;
    for (const id of selected) this.queued.delete(id);
    if (accepted) {
      for (const id of selected) {
        this.receipts.add(id);
        if (this.receipts.size > this.capacity) this.receipts.delete(this.receipts.values().next().value!);
      }
    }
    this.change(async (session) => {
      await session.commit(async (tx) => {
        const doc = await tx.doc(Inbox, this.key, []);
        doc.pending = doc.pending.filter((p) => !selected.has(p.messageId));
        // A crash must not leave an input neither queued nor receipted after its tools ran.
        if (accepted) {
          for (const id of selected) if (!doc.receipts.includes(id)) doc.receipts.push(id);
          doc.receipts = doc.receipts.slice(-this.capacity);
        }
      }, BACKGROUND_CONTEXT);
    });
  }

  async pending(): Promise<readonly DurableInput[]> {
    await this.flush();
    return (await this.session!.snapshot(Inbox, this.key, BACKGROUND_CONTEXT))!.pending;
  }

  /** Model and tool hooks await this fence; a failed checkpoint blocks tool execution. */
  async flush(): Promise<void> {
    await this.open();
    await this.writes;
    if (this.failure !== undefined) throw this.failure;
  }

  async close(): Promise<void> {
    if (!this.opening) return;
    try {
      await this.flush();
    } finally {
      if (this.ownsStore) await this.store.close();
    }
  }

  private change(write: (session: Session) => Promise<void>): void {
    this.writes = this.writes.then(async () => {
      await this.open();
      if (this.failure !== undefined) return;
      await write(this.session!);
    }).catch((err: unknown) => { this.failure = err instanceof Error ? err : new Error(String(err)); });
  }
}
