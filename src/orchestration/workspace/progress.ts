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

export function toolsLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
