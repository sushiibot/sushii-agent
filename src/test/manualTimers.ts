import type { Timers } from "../orchestration/workspace/progress.ts";

/** A clock local to one test; no global timer mocks can leak into other suites. */
export function manualTimers() {
  let now = 0;
  const pending = new Map<symbol, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      const handle = Symbol();
      pending.set(handle, { at: now + ms, fn });
      return handle;
    },
    clear(handle) { pending.delete(handle as symbol); },
  };
  return {
    timers,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        pending.delete(handle);
        timer.fn();
        await Promise.resolve();
      }
      now = until;
    },
  };
}
