import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Attachment, Client } from "discord.js";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("wiki-sync:attachments");

const CDN_MARKER = "cdn.discordapp.com/attachments/";
const CDN_LABEL_URL_RE = /\]\((https:\/\/cdn\.discordapp\.com\/attachments\/\d+\/(\d+)\/[^\s)]+)\)/g;

const MAX_BYTES = Number(Bun.env.WIKI_SYNC_ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024);
const PDF_MAX_PAGES = Number(Bun.env.WIKI_SYNC_PDF_MAX_PAGES ?? 12);
const PDF_DPI = Number(Bun.env.WIKI_SYNC_PDF_DPI ?? 150);
const PDF_PAGE_MAX_LONG_EDGE = 1568;
const DOWNLOAD_CONCURRENCY = 4;
export const MESSAGE_CONCURRENCY = 4;

const TEXT_LIKE_EXT_RE = /\.(txt|md|csv|log|json|ya?ml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|sh|toml|ini)$/i;

function isImage(contentType: string | null): boolean {
  return !!contentType && contentType.startsWith("image/");
}

function isPdf(contentType: string | null, name: string): boolean {
  return contentType === "application/pdf" || /\.pdf$/i.test(name);
}

function isTextLike(contentType: string | null, name: string): boolean {
  if (contentType && (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("csv"))) {
    return true;
  }
  return TEXT_LIKE_EXT_RE.test(name);
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 150) || "file";
}

export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const item = items[index++]!;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function downloadBytes(attachment: Attachment): Promise<Uint8Array | null> {
  if (attachment.size > MAX_BYTES) {
    logger.warn({ attachmentId: attachment.id, size: attachment.size }, "attachment exceeds max size, skipping");
    return null;
  }
  const res = await fetch(attachment.url);
  if (!res.ok) {
    logger.warn({ attachmentId: attachment.id, status: res.status }, "attachment download failed");
    return null;
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function runSpawn(cmd: string[]): Promise<{ ok: boolean; stderr: string }> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stderr };
  } catch (err) {
    return { ok: false, stderr: String(err) };
  }
}

/** What a materialized attachment rewrites its markdown label to: the link target, plus optional trailing text appended after the closing `)`. */
interface Replacement {
  url: string;
  extra?: string;
}

async function materializeImage(msgDir: string, attachment: Attachment): Promise<Replacement | null> {
  const bytes = await downloadBytes(attachment);
  if (!bytes) return null;
  await mkdir(msgDir, { recursive: true });
  const filePath = join(msgDir, `${attachment.id}-${safeName(attachment.name)}`);
  await writeFile(filePath, bytes);
  return { url: resolve(filePath) };
}

async function materializeText(msgDir: string, attachment: Attachment): Promise<Replacement | null> {
  const bytes = await downloadBytes(attachment);
  if (!bytes) return null;
  await mkdir(msgDir, { recursive: true });
  const filePath = join(msgDir, `${attachment.id}-${safeName(attachment.name)}`);
  await writeFile(filePath, bytes);
  return { url: resolve(filePath) };
}

/** Longest page dimension in PDF points (1/72in), from `pdfinfo`'s "Page size: W x H pts" line, or null if it can't be determined. */
async function pdfPageLongEdgePoints(pdfPath: string): Promise<number | null> {
  const proc = Bun.spawn({ cmd: ["pdfinfo", pdfPath], stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const match = stdout.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)/);
  if (!match) return null;
  return Math.max(Number(match[1]), Number(match[2]));
}

/**
 * Text-extracts first; only rasterizes if the PDF turns out to be scanned/image-only (empty
 * `pdftotext` output). The render DPI is clamped (via `pdfinfo`'s page size) so the long edge
 * never exceeds `PDF_PAGE_MAX_LONG_EDGE` — `-scale-to*` flags were tried but force every page,
 * including ones already under the cap, into an exact target box (both up- and down-scaling),
 * which isn't the "only downscale if it's actually too big" behavior wanted here.
 */
async function materializePdf(msgDir: string, attachment: Attachment): Promise<Replacement | null> {
  const bytes = await downloadBytes(attachment);
  if (!bytes) return null;
  await mkdir(msgDir, { recursive: true });

  const pdfPath = join(msgDir, `${attachment.id}-${safeName(attachment.name)}`);
  await writeFile(pdfPath, bytes);

  const txtPath = `${pdfPath}.txt`;
  const textResult = await runSpawn(["pdftotext", pdfPath, txtPath]);
  if (textResult.ok) {
    try {
      const text = await readFile(txtPath, "utf8");
      if (text.trim().length > 0) {
        return { url: resolve(txtPath) };
      }
    } catch (err) {
      logger.debug({ err, attachmentId: attachment.id }, "pdftotext output unreadable, falling back to rasterize");
    }
  } else {
    logger.debug({ stderr: textResult.stderr, attachmentId: attachment.id }, "pdftotext unavailable or failed, falling back to rasterize");
  }

  let dpi = PDF_DPI;
  const longEdgePts = await pdfPageLongEdgePoints(pdfPath);
  if (longEdgePts && longEdgePts > 0) {
    const capDpi = Math.floor((PDF_PAGE_MAX_LONG_EDGE * 72) / longEdgePts);
    if (capDpi > 0 && capDpi < dpi) dpi = capDpi;
  }

  const pagePrefix = join(msgDir, `${attachment.id}-pg`);
  const rasterResult = await runSpawn([
    "pdftoppm",
    "-png",
    "-r",
    String(dpi),
    "-f",
    "1",
    "-l",
    String(PDF_MAX_PAGES),
    pdfPath,
    pagePrefix,
  ]);
  if (!rasterResult.ok) {
    logger.warn({ stderr: rasterResult.stderr, attachmentId: attachment.id }, "pdftoppm unavailable or failed, leaving pdf label unchanged");
    return null;
  }

  const prefixBase = `${attachment.id}-pg`;
  const pages = (await readdir(msgDir))
    .filter((f) => f.startsWith(prefixBase) && f.endsWith(".png"))
    .sort()
    .map((f) => resolve(join(msgDir, f)));

  if (pages.length === 0) {
    logger.warn({ attachmentId: attachment.id }, "pdftoppm produced no pages, leaving pdf label unchanged");
    return null;
  }
  return { url: pages[0]!, extra: pages.length > 1 ? ` pages: ${pages.join(", ")}` : undefined };
}

async function materializeOne(msgDir: string, attachment: Attachment): Promise<Replacement | null> {
  if (isImage(attachment.contentType)) return materializeImage(msgDir, attachment);
  if (isPdf(attachment.contentType, attachment.name)) return materializePdf(msgDir, attachment);
  if (isTextLike(attachment.contentType, attachment.name)) return materializeText(msgDir, attachment);
  return null;
}

function rewriteContent(content: string, replacements: Map<string, Replacement>): string {
  return content.replace(CDN_LABEL_URL_RE, (full, _url, attachmentId) => {
    const replacement = replacements.get(attachmentId);
    return replacement ? `](${replacement.url})${replacement.extra ?? ""}` : full;
  });
}

/**
 * Rewrites a message's content so any Discord attachment labels point at local files instead of
 * CDN URLs, which are already expired by the time a sweep runs this. Refetches the live message
 * to get fresh, re-signed attachment URLs rather than trusting what's stored in `content`.
 *
 * Never throws: any failure (deleted message, lost channel access, missing pdftotext/pdftoppm,
 * a single attachment's download failing) degrades to leaving the affected label(s) as-is rather
 * than failing the whole sweep.
 */
export async function materializeMessageAttachments(
  client: Client,
  attachmentsDir: string,
  message: WikiSyncMessage,
): Promise<string> {
  if (!message.content.includes(CDN_MARKER)) {
    return message.content;
  }

  let attachments: Attachment[];
  try {
    const channel = await client.channels.fetch(message.channelId);
    if (!channel || !channel.isTextBased()) {
      logger.debug({ channelId: message.channelId }, "channel not text-based, skipping attachment materialize");
      return message.content;
    }
    const fresh = await channel.messages.fetch(message.discordId);
    attachments = [...fresh.attachments.values()];
  } catch (err) {
    logger.warn({ err, channelId: message.channelId, discordId: message.discordId }, "failed to refetch message for attachments");
    return message.content;
  }

  if (attachments.length === 0) {
    return message.content;
  }

  const msgDir = join(attachmentsDir, message.discordId);
  const replacements = new Map<string, Replacement>();

  await runPool(attachments, DOWNLOAD_CONCURRENCY, async (attachment) => {
    try {
      const replacement = await materializeOne(msgDir, attachment);
      if (replacement) replacements.set(attachment.id, replacement);
    } catch (err) {
      logger.warn({ err, attachmentId: attachment.id }, "failed to materialize attachment, leaving label unchanged");
    }
  });

  if (replacements.size === 0) {
    return message.content;
  }
  return rewriteContent(message.content, replacements);
}
