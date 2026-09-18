import { getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { getLogger } from "../../logger.ts";

const logger = getLogger("surfaces/buzz/client");

/** A message/feed event as the `buzz` CLI emits it (normalized JSON). */
export interface BuzzEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  createdAt: number;
  tags: string[][];
}

export interface BuzzSendResult {
  eventId: string;
  accepted: boolean;
}

/** A community channel as `buzz channels list` emits it. Only `id` is guaranteed. */
export interface BuzzChannel {
  id: string;
  name: string;
  topic?: string;
  purpose?: string;
  description?: string;
  visibility?: string;
}

/** The buzz operations the surface needs. Injected so the gateway/session can be tested without
 *  spawning the real CLI or reaching a relay. */
export interface BuzzClient {
  /** The agent's own hex pubkey (derived from BUZZ_PRIVATE_KEY). */
  ownPubkey(): Promise<string>;
  /** Publish the bot's own kind:0 profile display name (per-community, replaceable). */
  setProfile(displayName: string): Promise<void>;
  /** Mentions of the agent with created_at strictly after `sinceTs` (unix seconds), oldest first. */
  feedMentions(sinceTs: number, limit?: number): Promise<BuzzEvent[]>;
  /** Post a reply into `channelId`, threaded under `replyToId` (the mentioned event). */
  send(channelId: string, content: string, replyToId?: string): Promise<BuzzSendResult>;
  /** Add an emoji reaction to an event (NIP-25). Used as a lightweight "seen" ack. */
  react(eventId: string, emoji: string): Promise<void>;
  /** Channels visible to the bot in this community — the scannable structure for server context. */
  channelsList(limit?: number): Promise<BuzzChannel[]>;
}

export class BuzzCliError extends Error {
  constructor(message: string, readonly category: string, readonly exitCode: number) {
    super(message);
    this.name = "BuzzCliError";
  }
}

/** Spawns the `buzz` CLI (must be on PATH). Config comes from env vars the CLI reads itself. */
export class CliBuzzClient implements BuzzClient {
  constructor(
    private readonly env: { privateKey: string; relayUrl?: string; authTag?: string },
    private readonly bin = "buzz",
  ) {}

  private async run(args: string[], stdin?: string): Promise<unknown> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      BUZZ_PRIVATE_KEY: this.env.privateKey,
    };
    // Set the relay explicitly, or drop it entirely so an inherited empty BUZZ_RELAY_URL="" (what the
    // ansible default renders) can't override the CLI's own default with a blank value.
    if (this.env.relayUrl) env.BUZZ_RELAY_URL = this.env.relayUrl;
    else delete env.BUZZ_RELAY_URL;
    if (this.env.authTag) env.BUZZ_AUTH_TAG = this.env.authTag;
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      // The CLI documents errors as JSON on stderr: {"error": "<category>", "message": "<detail>"}.
      let category = "other";
      let message = stderr.trim() || `buzz exited ${exitCode}`;
      try {
        const parsed = JSON.parse(stderr) as { error?: string; message?: string };
        if (parsed.error) category = parsed.error;
        if (parsed.message) message = parsed.message;
      } catch {
        // Non-JSON stderr — keep the raw text.
      }
      throw new BuzzCliError(message, category, exitCode);
    }
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the BuzzClient contract
  async ownPubkey(): Promise<string> {
    // Derived offline from the configured key — the pubkey is the keypair's x-only public key, so it
    // needs no relay. (`buzz users get` queries the relay and returns nothing until the bot has a
    // profile there, which would deadlock: no pubkey -> no profile -> no pubkey.)
    const raw = this.env.privateKey.trim();
    let sk: Uint8Array;
    if (raw.startsWith("nsec")) {
      const decoded = nip19.decode(raw);
      if (decoded.type !== "nsec") throw new BuzzCliError("BUZZ_PRIVATE_KEY is not a valid nsec", "auth", 0);
      sk = decoded.data;
    } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      sk = Uint8Array.from(Buffer.from(raw, "hex"));
    } else {
      throw new BuzzCliError("BUZZ_PRIVATE_KEY must be 64-char hex or an nsec", "auth", 0);
    }
    return getPublicKey(sk);
  }

  async setProfile(displayName: string): Promise<void> {
    // Explicit --format json like the sibling calls, so run()'s JSON.parse doesn't choke on a
    // human-readable confirmation line and log a successful publish as a failure.
    await this.run(["--format", "json", "users", "set-profile", "--name", displayName]);
  }

  async feedMentions(sinceTs: number, limit = 50): Promise<BuzzEvent[]> {
    const result = await this.run(["--format", "json", "feed", "get", "--types", "mentions", "--since", String(sinceTs), "--limit", String(limit)]);
    const rows = Array.isArray(result) ? result : ((result as { items?: unknown[] } | null)?.items ?? []);
    return rows.map(normalizeEvent).filter((e): e is BuzzEvent => e !== null);
  }

  async send(channelId: string, content: string, replyToId?: string): Promise<BuzzSendResult> {
    const args = ["messages", "send", "--channel", channelId, "--content", "-"];
    if (replyToId) args.push("--reply-to", replyToId);
    const result = (await this.run(args, content)) as { event_id?: string; eventId?: string; accepted?: boolean } | null;
    return { eventId: result?.event_id ?? result?.eventId ?? "", accepted: result?.accepted ?? false };
  }

  async react(eventId: string, emoji: string): Promise<void> {
    await this.run(["--format", "json", "reactions", "add", "--event", eventId, "--emoji", emoji]);
  }

  async channelsList(limit = 500): Promise<BuzzChannel[]> {
    const result = await this.run(["--format", "json", "channels", "list", "--limit", String(limit)]);
    const rows = Array.isArray(result) ? result : ((result as { items?: unknown[] } | null)?.items ?? []);
    return rows.map(normalizeChannel).filter((c): c is BuzzChannel => c !== null);
  }
}

/** Tolerates snake_case/camelCase and missing optional fields; returns null for a malformed row. */
function normalizeChannel(raw: unknown): BuzzChannel | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string") {
    logger.warn({ raw }, "skipping malformed buzz channel");
    return null;
  }
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof r[k] === "string") return r[k] as string;
    return undefined;
  };
  return {
    id: r.id,
    name: str("name", "display_name", "displayName") ?? r.id,
    topic: str("topic"),
    purpose: str("purpose"),
    description: str("description"),
    visibility: str("visibility"),
  };
}

/** Tolerates snake_case (`created_at`) or camelCase from the CLI. Returns null for a malformed row. */
function normalizeEvent(raw: unknown): BuzzEvent | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== "string" || typeof r.pubkey !== "string") {
    logger.warn({ raw }, "skipping malformed buzz event");
    return null;
  }
  const createdAt = typeof r.created_at === "number" ? r.created_at : typeof r.createdAt === "number" ? r.createdAt : 0;
  return {
    id: r.id,
    pubkey: r.pubkey,
    kind: typeof r.kind === "number" ? r.kind : 0,
    content: typeof r.content === "string" ? r.content : "",
    createdAt,
    tags: Array.isArray(r.tags) ? (r.tags as string[][]) : [],
  };
}

/** Channel UUID from a message's `h` tag; null if absent. */
export function channelIdOf(event: BuzzEvent): string | null {
  const tag = event.tags.find((t) => t[0] === "h");
  return tag?.[1] ?? null;
}
