import { conversationKey, type ConversationRef, type HookBus, type ToolActivity } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import type { SlackPostClient } from "./session.ts";

const logger = getLogger("surfaces/slack/progress");

const DEBOUNCE_MS = 500;
const VISIBLE_LINES = 3;
const ARG_MAX = 40;

// sushii is a chef — the "working" header reads like something's on the stove. One phrase is picked
// per turn (stable, so edits don't flicker between verbs).
const COOKING = [
  ":fried_egg: Frying something up…",
  ":ramen: Simmering…",
  ":sushi: Rolling it out…",
  ":knife: Prepping…",
  ":rice: Steaming…",
  ":curry: Marinating on it…",
  ":stew: Bringing it to a boil…",
  ":fried_shrimp: Battering up…",
];
const pickCooking = (): string => COOKING[Math.floor(Math.random() * COOKING.length)];

function formatArg(value: unknown): string {
  if (typeof value === "string") return `"${value.length > ARG_MAX ? `${value.slice(0, ARG_MAX)}…` : value}"`;
  return JSON.stringify(value);
}

/** Live tool-progress for a Slack turn. Posts one "working" message on the first tool batch and edits
 *  it in place (chat.update) as more tools dispatch — the same idea as the Discord ToolProgressTracker.
 *  Edits are cosmetic: a failed post/update is swallowed and never allowed to disturb the turn or its
 *  real reply. */
export class SlackToolProgress {
  private messageTs: string | null = null;
  private lines: string[] = [];
  private lastContent = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly header = pickCooking();

  constructor(
    private readonly client: SlackPostClient,
    private readonly channelId: string,
    private readonly threadTs: string,
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
      if (!this.messageTs) {
        const res = await this.client.chat.postMessage({ channel: this.channelId, text: this.lastContent, thread_ts: this.threadTs });
        this.messageTs = res.ts || null;
      } else {
        await this.client.chat.update({ channel: this.channelId, ts: this.messageTs, text: this.lastContent });
      }
    } catch (err) {
      logger.warn({ err }, "slack tool-progress update failed");
    }
  }

  /** End the progress display. `errorText` marks a failed turn — it is rendered onto the progress
   *  message if one exists, else posted as a fresh reply so a failure is never silent. On success
   *  with a pending first flush (no message posted yet), nothing is created — the answer stands alone. */
  async finalize(errorText?: string): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    try {
      if (this.messageTs) {
        const content = errorText ? `${this.lastContent ? `${this.lastContent}\n\n` : ""}⚠️ ${errorText}` : this.lastContent;
        if (content) await this.client.chat.update({ channel: this.channelId, ts: this.messageTs, text: content });
      } else if (errorText) {
        await this.client.chat.postMessage({ channel: this.channelId, text: `⚠️ ${errorText}`, thread_ts: this.threadTs });
      }
    } catch (err) {
      logger.warn({ err }, "slack tool-progress finalize failed");
    }
  }
}

/** A live tracker per active Slack conversation, so the shared hook bus can route onToolsDispatched to
 *  the right turn. The gateway owns tracker lifecycle (create on inbound, finalize on completion). */
export interface SlackProgressRegistry {
  track(conversation: ConversationRef, tracker: SlackToolProgress): void;
  untrack(conversation: ConversationRef): void;
}

/** Registers the Slack progress hook on `bus` once. Conversation keys are surface + conversation
 *  scoped, so trackers never collide across workspaces. */
export function registerSlackProgressHooks(bus: HookBus): SlackProgressRegistry {
  const trackers = new Map<string, SlackToolProgress>();
  bus.on("onToolsDispatched", ({ conversation, tools }) => {
    trackers.get(conversationKey(conversation))?.add(tools);
  });
  return {
    track: (conversation, tracker) => trackers.set(conversationKey(conversation), tracker),
    untrack: (conversation) => trackers.delete(conversationKey(conversation)),
  };
}
