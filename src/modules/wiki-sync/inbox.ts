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

function formatMessageLine(m: WikiSyncMessage): string {
  const author = m.authorDisplayName ?? m.authorUsername;
  const timestamp = new Date(m.createdAt).toISOString();
  const replyPrefix = m.replyTo ? `↳ replying to ${m.replyTo.author} ("${m.replyTo.content}") — ` : "";
  return `[${timestamp}] ${replyPrefix}${author}: ${m.content}`;
}

/**
 * Writes one markdown file per channel (or per thread) into `inboxDir`, replacing any previous
 * batch, so the model can read/grep a per-channel file instead of a single flat blob — gives it
 * channel grouping and a legible name instead of a bare snowflake id.
 *
 * `inboxDir` is expected to sit outside the wiki repo's git working tree entirely (see
 * sweep.ts) — Pi's filesystem tools aren't cwd-sandboxed, so it can still read an absolute
 * path here even though the session's cwd is the repo checkout. That keeps raw Discord content
 * physically incapable of being swept up by `git add -A`, rather than merely excluded from it.
 */
export async function writeMessageInbox(
  inboxDir: string,
  client: Client,
  messages: WikiSyncMessage[],
): Promise<{ files: string[] }> {
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

  const files: string[] = [];
  for (const group of groups.values()) {
    const fileName = `${fileStem(group)}.md`;
    const body = group.messages.map(formatMessageLine).join("\n");
    const filePath = join(inboxDir, fileName);
    await writeFile(filePath, `${fileHeader(group)}${body}\n`, "utf8");
    files.push(filePath);
  }

  return { files };
}
