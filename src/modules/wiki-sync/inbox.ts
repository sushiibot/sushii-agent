import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "discord.js";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";

function slugifyChannelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `general-<id>.md` when the channel is resolvable, else just `<id>.md` — the id suffix guarantees uniqueness even if two channels share a name. */
function channelFileStem(client: Client, channelId: string): string {
  const channel = client.channels.cache.get(channelId);
  const name = channel && "name" in channel && typeof channel.name === "string" ? slugifyChannelName(channel.name) : "";
  return name ? `${name}-${channelId}` : channelId;
}

/**
 * Writes one markdown file per channel into `inboxDir`, replacing any previous batch, so the
 * model can read/grep a per-channel file instead of a single flat blob — gives it channel
 * grouping and a legible name instead of a bare snowflake id.
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

  const byChannel = new Map<string, WikiSyncMessage[]>();
  for (const message of messages) {
    const bucket = byChannel.get(message.channelId);
    if (bucket) bucket.push(message);
    else byChannel.set(message.channelId, [message]);
  }

  const files: string[] = [];
  for (const [channelId, channelMessages] of byChannel) {
    const fileName = `${channelFileStem(client, channelId)}.md`;
    const lines = channelMessages.map((m) => {
      const author = m.authorDisplayName ?? m.authorUsername;
      const timestamp = new Date(m.createdAt).toISOString();
      return `[${timestamp}] ${author}: ${m.content}`;
    });
    const filePath = join(inboxDir, fileName);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    files.push(filePath);
  }

  return { files };
}
