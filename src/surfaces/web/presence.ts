import { realTimers, type Timers } from "../../orchestration/workspace/progress.ts";

export const SEEN_WAIT_MS = 8_000;

/** Push suppression. Only a POSTed seen receipt suppresses a push; an open stream never does, since a
 *  backgrounded tab can hold one open without anyone looking. */
export interface Presence {
  open(streamId: string): () => void;
  seen(seq: number): void;
  /** False once a receipt for `seq` or later arrives within SEEN_WAIT_MS. With no stream open, nothing
   *  can see it, so this resolves true at once. */
  shouldPush(seq: number): Promise<boolean>;
}

/** `head` is the newest issued seq; a receipt past it is clamped, so a bogus one can't mute later pushes. */
export function createPresence(opts: { head: () => number; timers?: Timers; waitMs?: number }): Presence {
  const timers = opts.timers ?? realTimers;
  const waitMs = opts.waitMs ?? SEEN_WAIT_MS;
  const streams = new Map<string, number>();
  const waiters = new Set<{ seq: number; done: (push: boolean) => void }>();
  let maxSeen = 0;

  return {
    open(streamId) {
      streams.set(streamId, (streams.get(streamId) ?? 0) + 1);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const n = (streams.get(streamId) ?? 1) - 1;
        if (n > 0) streams.set(streamId, n);
        else streams.delete(streamId);
      };
    },
    seen(seq) {
      if (!Number.isSafeInteger(seq)) return;
      seq = Math.min(seq, opts.head());
      if (seq <= maxSeen) return;
      maxSeen = seq;
      for (const w of [...waiters]) if (w.seq <= seq) w.done(false);
    },
    shouldPush(seq) {
      if (maxSeen >= seq) return Promise.resolve(false);
      if (streams.size === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const waiter = {
          seq,
          done: (push: boolean) => {
            waiters.delete(waiter);
            timers.clear(timer);
            resolve(push);
          },
        };
        const timer = timers.set(() => waiter.done(true), waitMs);
        waiters.add(waiter);
      });
    },
  };
}
