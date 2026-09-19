import { conversationKey, type ConversationRef, type HookBus, type ToolActivity } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import type { BuzzClient } from "./buzzClient.ts";

const logger = getLogger("surfaces/buzz/progress");

// Higher than Discord's 500ms: every edit is a signed event the relay fans out to all clients, so a
// long tool loop stays calm rather than emitting ~one event per iteration.
const DEBOUNCE_MS = 1000;
const VISIBLE_LINES = 3;
const ARG_MAX = 40;

// sushii is a chef — the "working" header reads like something's on the stove. One phrase is picked
// per turn (stable, so edits don't flicker between verbs).
const COOKING = [
  "🍳 Frying something up…",
  "🍜 Simmering…",
  "🍣 Rolling it out…",
  "🔪 Prepping…",
  "🍚 Steaming…",
  "🥘 Marinating on it…",
  "🍲 Bringing it to a boil…",
  "🍤 Battering up…",
];
const pickCooking = (): string => COOKING[Math.floor(Math.random() * COOKING.length)];

function formatArg(value: unknown): string {
  if (typeof value === "string") return `"${value.length > ARG_MAX ? `${value.slice(0, ARG_MAX)}…` : value}"`;
  return JSON.stringify(value);
}

/** Live tool-progress for a buzz turn. Posts one "working" message on the first tool batch and edits
 *  it in place (kind:40003) as more tools dispatch — the same idea as the Discord ToolProgressTracker,
 *  but over nostr edits since buzz has no rich components. Edits are cosmetic: a failed publish is
 *  swallowed and never allowed to disturb the turn or its real reply. */
export class BuzzToolProgress {
  private eventId: string | null = null;
  private lines: string[] = [];
  private lastContent = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly header = pickCooking();

  constructor(
    private readonly client: BuzzClient,
    private readonly channelId: string,
    private readonly replyToId: string,
  ) {}

  add(tools: ToolActivity[]): void {
    for (const { name, input } of tools) {
      const args = Object.entries(input).map(([k, v]) => `${k}=${formatArg(v)}`).join(", ");
      this.lines.push(args ? `${name}(${args})` : name);
    }
    this.scheduleFlush();
  }

  private buildContent(): string {
    const hidden = this.lines.length - VISIBLE_LINES;
    const visible = hidden > 0 ? this.lines.slice(-VISIBLE_LINES) : this.lines;
    const header = hidden > 0 ? [`…${hidden} earlier tool call${hidden === 1 ? "" : "s"}`] : [];
    return [this.header, ...header, ...visible.map((l) => `• ${l}`)].join("\n").slice(0, 1500);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flush(); }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    this.lastContent = this.buildContent();
    try {
      if (!this.eventId) {
        const res = await this.client.send(this.channelId, this.lastContent, this.replyToId);
        this.eventId = res.eventId || null;
      } else {
        await this.client.edit(this.channelId, this.eventId, this.lastContent);
      }
    } catch (err) {
      logger.warn({ err }, "buzz tool-progress update failed");
    }
  }

  /** End the progress display. `errorText` marks a failed turn — it is rendered onto the progress
   *  message if one exists, else posted as a fresh reply so a failure is never silent. On success
   *  with a pending first flush (no message posted yet), nothing is created — the answer stands alone. */
  async finalize(errorText?: string): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    try {
      if (this.eventId) {
        const content = errorText ? `${this.lastContent ? `${this.lastContent}\n\n` : ""}⚠️ ${errorText}` : this.lastContent;
        if (content) await this.client.edit(this.channelId, this.eventId, content);
      } else if (errorText) {
        await this.client.send(this.channelId, `⚠️ ${errorText}`, this.replyToId);
      }
    } catch (err) {
      logger.warn({ err }, "buzz tool-progress finalize failed");
    }
  }
}

/** A live tracker per active buzz conversation, so the shared hook bus can route onToolsDispatched to
 *  the right turn. The gateway owns tracker lifecycle (create on inbound, finalize on completion). */
export interface BuzzProgressRegistry {
  track(conversation: ConversationRef, tracker: BuzzToolProgress): void;
  untrack(conversation: ConversationRef): void;
}

/** Registers the buzz progress hook on `bus` once. One registry serves every relay sharing the bus —
 *  conversation keys are space-scoped, so trackers never collide across communities. */
export function registerBuzzProgressHooks(bus: HookBus): BuzzProgressRegistry {
  const trackers = new Map<string, BuzzToolProgress>();
  bus.on("onToolsDispatched", ({ conversation, tools }) => {
    trackers.get(conversationKey(conversation))?.add(tools);
  });
  return {
    track: (conversation, tracker) => trackers.set(conversationKey(conversation), tracker),
    untrack: (conversation) => trackers.delete(conversationKey(conversation)),
  };
}
