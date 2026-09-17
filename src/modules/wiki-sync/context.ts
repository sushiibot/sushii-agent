import type { WikiRepo } from "./git.ts";

// The capability bag the wiki-sync engine runs against (C12) — no discord.js. A surface supplies
// concrete impls (the Discord ones live in src/surfaces/discord/wikiSync.ts); a headless driver can
// supply its own, letting sweeps run without a Discord client (C14).

/** Neutral attachment shape (ports the fields materializeOne reads off a discord.js Attachment). */
export interface FetchedAttachment {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}

export interface ChannelNameResolver {
  /** Channel/thread display name, or null when unresolvable. */
  resolve(channelId: string): string | null;
}

export interface AttachmentSource {
  /** Fresh attachments for a message — Discord CDN URLs expire, so this is a live re-fetch. */
  fetchMessageAttachments(channelId: string, messageId: string): Promise<FetchedAttachment[]>;
}

export interface SyncNotifier {
  /** Post the post-sweep status for a pushed commit. Never throws — a failed notification must not
   *  fail the sweep. */
  postStatus(opts: { repo: WikiRepo; commitSha: string }): Promise<void>;
}

export interface WikiSyncContext {
  channelNames: ChannelNameResolver;
  attachments: AttachmentSource;
  notify: SyncNotifier;
}
