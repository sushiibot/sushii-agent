import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "discord.js";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";

function slugifyChannelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveChannelName(client: Client, channelId: string): string | null {
  const channel = client.channels.cache.get(channelId);
  return channel && "name" in channel && typeof channel.name === "string" ? channel.name : null;
}

/**
 * A batch of messages that all share one channelId — which may be an ordinary channel or a
 * thread. Threads get their parent channel resolved so the relationship isn't lost: a thread's
 * channel_id is its own snowflake, distinct from the channel it lives under (see
 * db/messages.ts), so without this a thread's messages would read as an unplaced, orphaned
 * conversation with no indication of where they belong.
 */
interface ChannelGroup {
  channelId: string;
  channelName: string | null;
  parentChannelId: string | null;
  parentChannelName: string | null;
  messages: WikiSyncMessage[];
}

/** `general-<id>.md` / `general--buzz-setup-macos-<id>.md` when resolvable, else just `<id>.md`. */
function fileStem(group: ChannelGroup): string {
  const channelSlug = group.channelName ? slugifyChannelName(group.channelName) : "";
  if (!group.parentChannelId) {
    return channelSlug ? `${channelSlug}-${group.channelId}` : group.channelId;
  }
  const parentSlug = group.parentChannelName ? slugifyChannelName(group.parentChannelName) : group.parentChannelId;
  return `${parentSlug}--${channelSlug || group.channelId}-${group.channelId}`;
}

function fileHeader(group: ChannelGroup): string {
  if (group.parentChannelId) {
    const parentLabel = group.parentChannelName ? `#${group.parentChannelName}` : `channel ${group.parentChannelId}`;
    const threadLabel = group.channelName ?? group.channelId;
    return `# Thread "${threadLabel}" in ${parentLabel}\n\n`;
  }
  return group.channelName ? `# #${group.channelName}\n\n` : "";
}

// Consecutive messages from the same author, sent back to back with nothing in between, are one
// train of thought split across Discord's send box rather than distinct topics — repeating the
// full "[timestamp] (url) author (id ...)" header on every one is pure overhead for that case.
// A reply always starts (and stays) its own group of one: it's calling out a specific earlier
// message, which is exactly the context a merged block would bury.
function groupConsecutive(messages: WikiSyncMessage[]): WikiSyncMessage[][] {
  const groups: WikiSyncMessage[][] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && !m.replyTo && last[0]!.authorId === m.authorId) {
      last.push(m);
    } else {
      groups.push([m]);
    }
  }
  return groups;
}

// The Discord id is the only thing about a person that's actually stable — username, display
// name, and server nickname can all independently change or differ, and the inbox itself is
// wiped every sweep (no history to cross-reference against), so the id is what lets the model
// recognize "same person" across a name change instead of accidentally creating a duplicate
// people/ page. See AGENTS.md's "People pages" section for how it's expected to use this.
//
// Header line, then each message's own content on its own line below — never inlined after the
// header, even for a single message, so a header is always immediately followed by exactly the
// text someone sent and nothing else to parse out of one line. A merged run's URL points at its
// first message, not each individual one — precise enough for a citation into a train-of-thought
// burst, and worth the imprecision for not repeating the header per line. A run mixing a reply
// back in never happens: groupConsecutive never extends a group with a reply, so every group
// here is either size 1 or reply-free.
function formatMessageGroup(guildId: string, group: WikiSyncMessage[]): string {
  const first = group[0]!;
  const author = first.authorDisplayName ?? first.authorUsername;
  const timestamp = new Date(first.createdAt).toISOString();
  const url = `https://discord.com/channels/${guildId}/${first.channelId}/${first.discordId}`;
  const replyPrefix = first.replyTo ? `↳ replying to ${first.replyTo.author} ("${first.replyTo.content}") — ` : "";
  const runSuffix = group.length > 1 ? ` sent ${group.length} messages in a row` : "";
  const header = `[${timestamp}] (${url}) ${replyPrefix}${author} (id ${first.authorId})${runSuffix}`;
  const lines = group.map((m) => m.content);
  return `${header}\n${lines.join("\n")}`;
}

export interface InboxFile {
  path: string;
  channelId: string;
  parentChannelId: string | null;
}

/**
 * Writes one markdown file per channel (or per thread) into `inboxDir`, replacing any previous
 * batch, so the model can read/grep a per-channel file instead of a single flat blob — gives it
 * channel grouping and a legible name instead of a bare snowflake id. Returns each file's own
 * channel identity alongside its path so a caller can classify files (e.g. sweep.ts splitting
 * status-channel feedback out from regular wiki content) without re-deriving the filename
 * scheme itself.
 *
 * `inboxDir` is expected to sit outside the wiki repo's git working tree entirely (see
 * sweep.ts) — Pi's filesystem tools aren't cwd-sandboxed, so it can still read an absolute
 * path here even though the session's cwd is the repo checkout. That keeps raw Discord content
 * physically incapable of being swept up by `git add -A`, rather than merely excluded from it.
 */
export async function writeMessageInbox(
  inboxDir: string,
  client: Client,
  guildId: string,
  messages: WikiSyncMessage[],
): Promise<{ files: InboxFile[] }> {
  await rm(inboxDir, { recursive: true, force: true });
  await mkdir(inboxDir, { recursive: true });

  const groups = new Map<string, ChannelGroup>();
  for (const message of messages) {
    let group = groups.get(message.channelId);
    if (!group) {
      group = {
        channelId: message.channelId,
        channelName: resolveChannelName(client, message.channelId),
        parentChannelId: message.parentChannelId,
        parentChannelName: message.parentChannelId ? resolveChannelName(client, message.parentChannelId) : null,
        messages: [],
      };
      groups.set(message.channelId, group);
    }
    group.messages.push(message);
  }

  const files: InboxFile[] = [];
  for (const group of groups.values()) {
    const fileName = `${fileStem(group)}.md`;
    const body = groupConsecutive(group.messages)
      .map((g) => formatMessageGroup(guildId, g))
      .join("\n");
    const filePath = join(inboxDir, fileName);
    await writeFile(filePath, `${fileHeader(group)}${body}\n`, "utf8");
    files.push({ path: filePath, channelId: group.channelId, parentChannelId: group.parentChannelId });
  }

  return { files };
}
