import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Client } from "discord.js";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiRepo } from "./git.ts";

const logger = getLogger("wiki-sync:notify");

const MAX_CONTENT_LENGTH = 3800;

// Inlined rather than importing agent/delivery.ts's buildTextDisplayContainer: delivery.ts
// pulls in agent/loop.ts, which imports modules/registry.ts, which imports this module's own
// package (wiki-sync/index.ts) -- that closed a real circular-import chain that crash-looped
// the whole process in production (ReferenceError: Cannot access 'wikiSyncModule' before
// initialization). This two-line helper isn't worth reintroducing that dependency for.
function buildTextDisplayContainer(content: string): ContainerBuilder {
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder({ content }));
}

/**
 * Web URL for linking to a commit -- Forgejo and GitHub both serve /commit/<sha> at
 * https://host/path, regardless of which transport wiki-sync itself pushes over.
 *   ssh://git@host:port/path.git -> https://host/path
 *   https://host/path.git        -> https://host/path (strip .git, drop any embedded credentials)
 */
export function deriveWebUrl(repoUrl: string): string | null {
  const sshMatch = repoUrl.match(/^ssh:\/\/git@([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    return `https://${host}/${path}`;
  }

  const httpsMatch = repoUrl.match(/^https?:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const [, host, path] = httpsMatch;
    return `https://${host}/${path}`;
  }

  return null;
}

/**
 * File-view URL for a path at a specific commit -- pinned to `ref` (not a branch) so the link
 * stays correct even after later commits change the file, matching the "View commit" link's own
 * permalink semantics. GitHub and Forgejo/Gitea (git.dreamcatcher.inc) use different path
 * shapes for this, unlike /commit/<sha> which both happen to share.
 */
function buildFilePermalink(webUrl: string, ref: string, path: string): string {
  const host = new URL(webUrl).hostname;
  const segment = host === "github.com" ? "blob" : "src/commit";
  return `${webUrl}/${segment}/${ref}/${path}`;
}

const ABSOLUTE_OR_ANCHOR_LINK = /^[a-z][a-z0-9+.-]*:|^#/i;

/**
 * Rewrites a wiki page's own relative markdown links (correct in the repo itself -- see
 * AGENTS.md's "real markdown link, relative path in parens" rule, which is what makes them
 * resolve on the git host's file browser, in a local clone, in any plain markdown viewer) into
 * absolute permalinks, for the copy of this content that gets posted to Discord. Discord has no
 * notion of "relative to this file" -- a link like `(../research/foo.md)` isn't clickable to
 * anything there, so this environment needs the resolved absolute form instead. `fromPath` is
 * the repo-relative path the content was read from, since that's what relative targets resolve
 * against.
 */
function absolutizeLinksForDiscord(content: string, fromPath: string, webUrl: string | null, ref: string): string {
  if (!webUrl) return content;
  return content.replace(/\]\(([^)\s]+)\)/g, (match, target: string) => {
    if (ABSOLUTE_OR_ANCHOR_LINK.test(target)) return match;
    const resolved = posix.normalize(posix.join(posix.dirname(fromPath), target));
    return `](${buildFilePermalink(webUrl, ref, resolved)})`;
  });
}

interface TouchedRecapFile {
  path: string;
  /** Whether this commit created the file, vs. touched one that already existed (and was
   * already shown in a prior sweep's status message). */
  isNew: boolean;
}

/**
 * Which recaps/<span>.md files this commit actually touched, oldest first. Not just
 * "today" -- a backlog-catchup sweep can span several calendar days in one commit, filed
 * under a range-named file instead of a single date (see the wiki's own AGENTS.md "Recap"
 * section). A span file is commonly appended to across multiple sweeps, so `isNew` (from
 * git's own added/modified/renamed status, not just presence in the diff) is what tells
 * buildRecapBody whether this is content nobody has seen yet or a revisit to an already-posted
 * file (e.g. a feedback-driven reformat).
 */
async function findTouchedRecapFiles(repo: WikiRepo, sha: string): Promise<TouchedRecapFile[]> {
  const output = await repo.git.raw(["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", sha]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...pathParts] = line.split("\t");
      return { status, path: pathParts[pathParts.length - 1] ?? "" };
    })
    .filter(({ path }) => path.startsWith("recaps/") && path.endsWith(".md"))
    .map(({ status, path }) => ({ path, isNew: status === "A" }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Builds the status message body, truncating only the recap portion so `commitLine` (the
 * "View commit" link) always survives -- naively truncating the whole concatenated body would
 * silently drop that link exactly when a reader needs it most: when the recap itself is too
 * long to show in full.
 */
export function buildStatusContent(recap: string | null, commitLine: string): string {
  if (!recap) return commitLine;

  const separator = "\n\n";
  const budget = Math.max(0, MAX_CONTENT_LENGTH - commitLine.length - separator.length - 1);
  const recapBody = recap.length > budget ? `${recap.slice(0, budget)}…` : recap;
  return `${recapBody}${separator}${commitLine}`;
}

/**
 * A brand-new recap file's content is shown in full -- nobody has seen it yet. A recap file this
 * commit merely touched again (a continued backfill span, or a feedback-driven reformat/fix) is
 * just named, not reproduced -- its content was already posted when it was new, and reposting
 * the whole file on every subsequent edit would repeat what a prior sweep's status message
 * already showed. The commit link already in the status message (see postSyncStatus) is where a
 * reader goes to see exactly what changed on a revisit.
 */
export async function buildRecapBody(repo: WikiRepo, commitSha: string, webUrl: string | null): Promise<string | null> {
  const recapFiles = await findTouchedRecapFiles(repo, commitSha).catch(() => []);
  if (recapFiles.length === 0) return null;

  const sections = await Promise.all(
    recapFiles.map(async ({ path, isNew }) => {
      const label = path.replace(/^recaps\/|\.md$/g, "");
      const heading = webUrl ? `[${label}](${buildFilePermalink(webUrl, commitSha, path)})` : `\`${label}\``;
      if (!isNew) return `Updated recap: ${heading}`;

      const raw = await readFile(join(repo.dir, path), "utf8")
        .then((c) => c.trim())
        .catch(() => null);
      if (!raw) return null;
      const content = absolutizeLinksForDiscord(raw, path, webUrl, commitSha);
      // One file: just its content. Multiple (a backfill sweep spanning days): label each.
      return recapFiles.length === 1 ? content : `**${heading}**\n${content}`;
    }),
  );
  const nonEmpty = sections.filter((s): s is string => s !== null);
  return nonEmpty.length > 0 ? nonEmpty.join("\n\n") : null;
}

/** Posts a status update to this guild's configured channel after a sweep pushes a commit. Never throws -- a failed notification shouldn't fail the sweep. */
export async function postSyncStatus(opts: { client: Client; guildId: string; repo: WikiRepo; commitSha: string }): Promise<void> {
  const channelId = config.guildConfig[opts.guildId]?.wiki?.statusChannelId;
  if (!channelId) return;

  try {
    const channel = await opts.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== opts.guildId) {
      logger.error({ guildId: opts.guildId, channelId }, "wikiSyncStatusChannelId is not a guild text channel");
      return;
    }

    const webUrl = deriveWebUrl(config.wikiSync.repoUrl ?? "");
    const recap = await buildRecapBody(opts.repo, opts.commitSha, webUrl);

    const commitLine = webUrl
      ? `[View commit](${webUrl}/commit/${opts.commitSha})`
      : `Commit \`${opts.commitSha.slice(0, 7)}\``;

    const content = buildStatusContent(recap ? recap.trim() : null, commitLine);

    const sent = await channel.send({
      components: [buildTextDisplayContainer(content)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });

    // A thread scoped to this specific sweep for discussing its output -- the next sweep reads
    // it back as feedback (see sweep.ts/prompt.ts). Non-fatal: a missing thread just means no
    // feedback surface for this one sync, not a failed notification.
    try {
      // Content spans whatever the sweep happened to touch, not one topic -- a generated
      // per-sync title would be noise, not a useful label. The date is what actually
      // distinguishes one thread from the next in the channel's thread list.
      const date = new Date().toISOString().slice(0, 10);
      await sent.startThread({ name: `${date} discuss this sync` });
    } catch (err) {
      logger.warn({ guildId: opts.guildId, channelId, err }, "failed to open feedback thread on status message");
    }
  } catch (err) {
    logger.error({ guildId: opts.guildId, channelId, err }, "failed to post status update");
  }
}
