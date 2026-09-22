import type {
  AgentReply,
  AuthorRef,
  PlatformRenderer,
  PromptGuidance,
  RenderContext,
  ReplySegment,
  SurfaceCapabilities,
  SurfaceSession,
  ToolHosts,
} from "../../core/contracts.ts";

// The write surface the agent loop needs — narrowed from `WebClient` so a fake client is trivial to
// construct in tests. `app.client` structurally satisfies this; the cast lives at the wiring boundary.
export interface SlackPostClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<{ ts?: string }>;
    update(args: { channel: string; ts: string; text: string }): Promise<unknown>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<{
      user?: {
        id?: string;
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
    }>;
  };
}

// Slack supports reactions (a "seen" ack) and in-place edits (live tool progress), so both are on.
// Threads and reply-to are native. Rich Block Kit components and interactive choices (ask_question /
// buttons) land in a later phase — gated off so the loop never deadlocks waiting on presentInteraction.
const SLACK_CAPABILITIES: SurfaceCapabilities = {
  richComponents: false,
  customEmoji: false,
  nativeTimestamps: false,
  threads: true,
  reactions: true,
  progress: true,
  interactiveChoices: false,
  typing: false,
  replyTo: true,
};

/** Passthrough renderer — the Slack behavior prompt never teaches the Discord u:/c:/t:/e: tokens, so
 *  there is nothing to expand. */
export class SlackPlatformRenderer implements PlatformRenderer {
  renderText(text: string, _ctx: RenderContext): string {
    return text;
  }
  promptGuidance(_ctx: RenderContext): PromptGuidance {
    return { sections: {} };
  }
  describeUser(author: AuthorRef): string {
    return author.displayName ?? author.username ?? author.userId;
  }
}

export function segmentsToText(segments: ReplySegment[]): string {
  return segments.map((s) => (s.kind === "separator" ? "\n\n---\n\n" : s.text)).join("");
}

export interface SlackSurfaceSessionOptions {
  client: SlackPostClient;
  /** Bot user id from auth.test (the loop-guard identity, exposed as selfId). */
  selfId: string;
  selfName: string;
  /** Slack channel id the message arrived in — where the reply is posted. */
  channelId: string;
  /** Thread the reply threads under (the triggering message's thread_ts, or its own ts). */
  threadTs: string;
}

export class SlackSurfaceSession implements SurfaceSession {
  readonly capabilities = SLACK_CAPABILITIES;
  readonly renderer = new SlackPlatformRenderer();
  readonly selfId: string;
  readonly selfName: string;
  // No fs host in Phase 2 — the per-workspace wiki mapping lands in a later phase.
  readonly hosts: ToolHosts = {};

  private readonly client: SlackPostClient;
  private readonly channelId: string;
  private readonly threadTs: string;

  constructor(opts: SlackSurfaceSessionOptions) {
    this.selfId = opts.selfId;
    this.selfName = opts.selfName;
    this.client = opts.client;
    this.channelId = opts.channelId;
    this.threadTs = opts.threadTs;
  }

  async deliver(reply: AgentReply): Promise<{ messageId?: string }> {
    const text = segmentsToText(reply.segments).trim();
    if (!text) return {};
    const result = await this.client.chat.postMessage({
      channel: this.channelId,
      text,
      thread_ts: this.threadTs,
    });
    return { messageId: result.ts || undefined };
  }
}
