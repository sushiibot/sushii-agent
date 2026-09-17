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

/** The buzz operations the surface needs. Injected so the gateway/session can be tested without
 *  spawning the real CLI or reaching a relay. */
export interface BuzzClient {
  /** The agent's own hex pubkey (derived from BUZZ_PRIVATE_KEY). */
  ownPubkey(): Promise<string>;
  /** Mentions of the agent with created_at strictly after `sinceTs` (unix seconds), oldest first. */
  feedMentions(sinceTs: number, limit?: number): Promise<BuzzEvent[]>;
  /** Post a reply into `channelId`, threaded under `replyToId` (the mentioned event). */
  send(channelId: string, content: string, replyToId?: string): Promise<BuzzSendResult>;
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
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUZZ_PRIVATE_KEY: this.env.privateKey,
        ...(this.env.relayUrl ? { BUZZ_RELAY_URL: this.env.relayUrl } : {}),
        ...(this.env.authTag ? { BUZZ_AUTH_TAG: this.env.authTag } : {}),
      },
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

  async ownPubkey(): Promise<string> {
    const result = await this.run(["--format", "compact", "users", "get"]);
    const profile = Array.isArray(result) ? result[0] : result;
    const pubkey = (profile as { pubkey?: unknown } | null)?.pubkey;
    if (typeof pubkey !== "string" || !pubkey) throw new BuzzCliError("buzz users get returned no pubkey", "other", 0);
    return pubkey;
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
