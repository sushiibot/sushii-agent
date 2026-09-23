import type {
  AgentReply,
  AuthorRef,
  FsHost,
  PlatformRenderer,
  PromptGuidance,
  RenderContext,
  ReplySegment,
  SurfaceCapabilities,
  SurfaceSession,
  ToolHosts,
  TurnPromptContext,
} from "../../core/contracts.ts";
import type { BuzzClient } from "./buzzClient.ts";

// Buzz is plain-text chat: no rich components, no reactions in the reply path, no interactive
// buttons (so ask_question gates off), no threads-as-entities. Only `replyTo` is real (we always
// reply to the mention that summoned us).
const BUZZ_CAPABILITIES: SurfaceCapabilities = {
  richComponents: false,
  customEmoji: false,
  nativeTimestamps: false,
  threads: false,
  reactions: false,
  progress: false,
  interactiveChoices: false,
  typing: false,
  replyTo: true,
};

/** Passthrough renderer — the buzz behavior prompt never teaches the Discord u:/c:/t:/e: tokens, so
 *  there is nothing to expand. */
export class BuzzPlatformRenderer implements PlatformRenderer {
  renderText(text: string, _ctx: RenderContext): string {
    return text;
  }
  promptGuidance(_ctx: RenderContext): PromptGuidance {
    return { sections: {} };
  }
  describeUser(author: AuthorRef): string {
    return author.username ?? author.userId;
  }
}

export function segmentsToText(segments: ReplySegment[]): string {
  return segments.map((s) => (s.kind === "separator" ? "\n\n---\n\n" : s.text)).join("");
}

export interface BuzzSurfaceSessionOptions {
  client: BuzzClient;
  ownPubkey: string;
  /** Buzz channel UUID the mention arrived in — where the reply is posted. */
  channelId: string;
  /** The mention event id, used as the reply-to (the CLI resolves the NIP-10 thread root). */
  replyToId: string;
  /** This community's wiki as an `fs` root (read/search/list). Omitted → no wiki tools for the
   *  community, so a community reads only the wiki its relay is explicitly mapped to. */
  fsHost?: FsHost;
}

export class BuzzSurfaceSession implements SurfaceSession {
  readonly capabilities = BUZZ_CAPABILITIES;
  readonly renderer = new BuzzPlatformRenderer();
  readonly selfId: string;
  readonly selfName = "sushii";
  readonly hosts: ToolHosts;

  private readonly client: BuzzClient;
  private readonly channelId: string;
  private readonly replyToId: string;

  promptContext(): TurnPromptContext {
    return { plainTimestamps: true };
  }

  constructor(opts: BuzzSurfaceSessionOptions) {
    this.selfId = opts.ownPubkey;
    this.client = opts.client;
    this.channelId = opts.channelId;
    this.replyToId = opts.replyToId;
    this.hosts = opts.fsHost ? { fs: opts.fsHost } : {};
  }

  async deliver(reply: AgentReply): Promise<{ messageId?: string }> {
    const text = segmentsToText(reply.segments).trim();
    if (!text) return {};
    const result = await this.client.send(this.channelId, text, this.replyToId);
    return { messageId: result.eventId || undefined };
  }
}
