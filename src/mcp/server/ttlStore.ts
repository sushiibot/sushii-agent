interface Entry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const MIN_SWEEP_INTERVAL_MS = 1_000;

/**
 * In-memory key -> value map with per-entry TTL and a max-entries cap (FIFO eviction via
 * Map's insertion order). Backs every short-lived server-side record in the MCP bridge —
 * by default none of it survives a restart, but an optional onWrite hook lets a caller
 * write through to durable storage (see ClientStore/SessionStore) for entries that should.
 */
export class TtlMap<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private lastSweptAt = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly onWrite?: (key: string, value: T, expiresAt: number) => void,
  ) {}

  set(key: string, value: T): void {
    // A full O(n) sweep on every write turns a write flood into O(n^2) work; only sweeping
    // once per second (or once we're actually full) keeps eviction cheap under load.
    const now = Date.now();
    if (this.entries.size >= this.maxEntries || now - this.lastSweptAt >= MIN_SWEEP_INTERVAL_MS) {
      this.sweep(now);
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const expiresAt = now + this.ttlMs;
    this.entries.set(key, { value, expiresAt });
    this.onWrite?.(key, value, expiresAt);
  }

  /** Seeds an entry with an already-computed expiry, bypassing onWrite — for hydrating from durable storage. */
  restore(key: string, value: T, expiresAt: number): void {
    this.entries.set(key, { value, expiresAt });
  }

  /** Returns the value for a valid, unexpired key without removing it; evicts if expired. */
  peek(key: string): T | null {
    const stored = this.entries.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return stored.value;
  }

  /** Single-use: removes the entry whether or not it was still valid. */
  take(key: string): T | null {
    const stored = this.entries.get(key);
    this.entries.delete(key);
    if (!stored || stored.expiresAt <= Date.now()) return null;
    return stored.value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  private sweep(now: number): void {
    this.lastSweptAt = now;
    for (const [key, stored] of this.entries) {
      if (stored.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export function randomId(byteLength: number, prefix?: string): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  const id = Buffer.from(bytes).toString("base64url");
  return prefix ? `${prefix}_${id}` : id;
}
