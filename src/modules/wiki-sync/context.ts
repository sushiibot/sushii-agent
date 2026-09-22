import type { WikiRepo } from "./git.ts";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";

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

export interface MessageSource {
  /** Unprocessed messages for one source space in `(since, until]`, oldest first, capped at
   *  `limit`. Each carries its own `surface`/`spaceId` so downstream code stays surface-neutral. */
  fetchUnprocessed(spaceId: string, since: number, until: number, limit: number): WikiSyncMessage[];
}

export interface ChannelNameResolver {
  /** Channel/thread display name, or null when unresolvable. */
  resolve(channelId: string): string | null;
}

/** What a materialized attachment rewrites its content reference to: the (local) link target, plus
 *  optional trailing text appended after the closing `)`. */
export interface Replacement {
  url: string;
  extra?: string;
}

export interface AttachmentSource {
  /** Attachments to materialize for this message, or `[]` when there are none. Owns any
   *  surface-specific detection and live re-fetch (e.g. Discord's expiring CDN URLs). */
  attachmentsFor(message: WikiSyncMessage): Promise<FetchedAttachment[]>;
  /** Rewrite the message content so each materialized attachment (keyed by its id) points at its
   *  local file. The mapping from a content reference to an attachment id is surface-specific. */
  rewriteAttachmentLinks(content: string, replacements: Map<string, Replacement>): string;
}

export interface SyncNotifier {
  /** Post the post-sweep status for a pushed commit. Never throws — a failed notification must not
   *  fail the sweep. */
  postStatus(opts: { repo: WikiRepo; commitSha: string }): Promise<void>;
}

export interface WikiSyncContext {
  messages: MessageSource;
  channelNames: ChannelNameResolver;
  attachments: AttachmentSource;
  /** Permalink back to the original message on its surface, or null when it has none. */
  linkFor(message: WikiSyncMessage): string | null;
  notify: SyncNotifier;
}
