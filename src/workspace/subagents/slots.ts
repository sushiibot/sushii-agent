export type SlotKind = "reader" | "writer";

interface Waiter {
  kind: SlotKind;
  grant: (release: () => void) => void;
  fail: (err: Error) => void;
}

/** FIFO per kind: at most `readers` read-only children and `writers` writers run at once. */
export class ChildSlots {
  private readonly active: Record<SlotKind, number> = { reader: 0, writer: 0 };
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limits: Record<SlotKind, number>) {}

  running(kind: SlotKind): number {
    return this.active[kind];
  }

  queued(kind: SlotKind): number {
    return this.waiting.filter((w) => w.kind === kind).length;
  }

  /** Fails every queued acquire, e.g. on shutdown. */
  rejectWaiting(err: Error): void {
    for (const w of this.waiting.splice(0)) w.fail(err);
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts first. */
  acquire(kind: SlotKind, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted while waiting for a subagent slot"));
    if (this.active[kind] < this.limits[kind]) return Promise.resolve(this.take(kind));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
        fail: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i !== -1) this.waiting.splice(i, 1);
        reject(new Error("aborted while waiting for a subagent slot"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private take(kind: SlotKind): () => void {
    this.active[kind]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active[kind]--;
      const i = this.waiting.findIndex((w) => w.kind === kind);
      if (i !== -1) this.waiting.splice(i, 1)[0].grant(this.take(kind));
    };
  }
}
