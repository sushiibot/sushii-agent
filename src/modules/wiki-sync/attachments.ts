import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AttachmentSource, FetchedAttachment, Replacement } from "./context.ts";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("wiki-sync:attachments");

const MAX_BYTES = Number(Bun.env.WIKI_SYNC_ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024);
const PDF_MAX_PAGES = Number(Bun.env.WIKI_SYNC_PDF_MAX_PAGES ?? 12);
const PDF_DPI = Number(Bun.env.WIKI_SYNC_PDF_DPI ?? 150);
const PDF_PAGE_MAX_LONG_EDGE = 1568;
const DOWNLOAD_CONCURRENCY = 4;
export const MESSAGE_CONCURRENCY = 4;

const FETCH_TIMEOUT_MS = Number(Bun.env.WIKI_SYNC_ATTACHMENT_FETCH_TIMEOUT_MS ?? 30_000);
const PDF_TIMEOUT_MS = Number(Bun.env.WIKI_SYNC_PDF_TIMEOUT_MS ?? 60_000);

/** Minimum extracted non-whitespace chars per page before text is preferred over rasterization. */
const PDF_MIN_TEXT_CHARS_PER_PAGE = 16;
/** Absolute floor applied when the page count can't be determined. */
const PDF_MIN_TEXT_CHARS_FLOOR = 32;

const TEXT_LIKE_EXT_RE = /\.(txt|md|csv|log|json|ya?ml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|sh|toml|ini)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function isImage(contentType: string | null, name: string): boolean {
  return (!!contentType && contentType.startsWith("image/")) || IMAGE_EXT_RE.test(name);
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

async function downloadBytes(attachment: FetchedAttachment): Promise<Uint8Array | null> {
  if (attachment.size > MAX_BYTES) {
    logger.warn({ attachmentId: attachment.id, size: attachment.size }, "attachment exceeds max size, skipping");
    return null;
  }
  try {
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn({ attachmentId: attachment.id, status: res.status }, "attachment download failed");
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    logger.warn({ err, attachmentId: attachment.id }, "attachment download timed out or errored");
    return null;
  }
}

/** Catches sync ENOENT from a missing binary and kills the process on timeout, so a bad PDF can't stall the pool. */
export async function runSpawn(cmd: string[], timeoutMs = PDF_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    // SIGKILL, not the default SIGTERM: a poppler process that traps/ignores SIGTERM (or is slow
    // to handle it during CPU-bound work) would otherwise keep running and `await proc.exited`
    // would never resolve, hanging one of the few pool workers for the whole sweep -- the timeout
    // must be able to actually reap the process.
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: exitCode === 0 && !timedOut, stdout, stderr: timedOut ? `${stderr}\n(timed out after ${timeoutMs}ms)` : stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

async function materializeImage(msgDir: string, attachment: FetchedAttachment): Promise<Replacement | null> {
  const bytes = await downloadBytes(attachment);
  if (!bytes) return null;
  await mkdir(msgDir, { recursive: true });
  const filePath = join(msgDir, `${attachment.id}-${safeName(attachment.name)}`);
  await writeFile(filePath, bytes);
  return { url: resolve(filePath) };
}

async function materializeText(msgDir: string, attachment: FetchedAttachment): Promise<Replacement | null> {
  const bytes = await downloadBytes(attachment);
  if (!bytes) return null;
  await mkdir(msgDir, { recursive: true });
  const filePath = join(msgDir, `${attachment.id}-${safeName(attachment.name)}`);
  await writeFile(filePath, bytes);
  return { url: resolve(filePath) };
}

/** Page count and longest page dimension in PDF points (1/72in), parsed from `pdfinfo`. Degrades to nulls (never throws) if the binary is missing, fails, or times out. */
async function pdfInfo(pdfPath: string): Promise<{ pages: number | null; longEdgePts: number | null }> {
  const result = await runSpawn(["pdfinfo", pdfPath]);
  if (!result.ok) return { pages: null, longEdgePts: null };

  const pagesMatch = result.stdout.match(/^Pages:\s*(\d+)/m);
  const sizeMatch = result.stdout.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)/);
  return {
    pages: pagesMatch ? Number(pagesMatch[1]) : null,
    longEdgePts: sizeMatch ? Math.max(Number(sizeMatch[1]), Number(sizeMatch[2])) : null,
  };
}

/**
 * Text-extracts first; only rasterizes if the PDF turns out to be scanned/image-only (empty
 * `pdftotext` output). The render DPI is clamped (via `pdfinfo`'s page size) so the long edge
 * never exceeds `PDF_PAGE_MAX_LONG_EDGE` — `-scale-to*` flags were tried but force every page,
 * including ones already under the cap, into an exact target box (both up- and down-scaling),
 * which isn't the "only downscale if it's actually too big" behavior wanted here.
 */
async function materializePdf(msgDir: string, attachment: FetchedAttachment): Promise<Replacement | null> {
  const bytes = await downloadBytes(attachment);
  if (!bytes) return null;
  await mkdir(msgDir, { recursive: true });

  const pdfPath = join(msgDir, `${attachment.id}-${safeName(attachment.name)}`);
  await writeFile(pdfPath, bytes);

  const { pages: pageCount, longEdgePts } = await pdfInfo(pdfPath);

  const txtPath = `${pdfPath}.txt`;
  const textResult = await runSpawn(["pdftotext", pdfPath, txtPath]);
  if (textResult.ok) {
    try {
      const text = await readFile(txtPath, "utf8");
      const nonWhitespaceLen = text.replace(/\s+/g, "").length;
      const minChars = pageCount ? Math.max(PDF_MIN_TEXT_CHARS_PER_PAGE * pageCount, PDF_MIN_TEXT_CHARS_FLOOR) : PDF_MIN_TEXT_CHARS_FLOOR;
      if (nonWhitespaceLen > minChars) {
        return { url: resolve(txtPath) };
      }
    } catch (err) {
      logger.debug({ err, attachmentId: attachment.id }, "pdftotext output unreadable, falling back to rasterize");
    }
  } else {
    logger.debug({ stderr: textResult.stderr, attachmentId: attachment.id }, "pdftotext unavailable or failed, falling back to rasterize");
  }

  let dpi = PDF_DPI;
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

async function materializeOne(msgDir: string, attachment: FetchedAttachment): Promise<Replacement | null> {
  if (isImage(attachment.contentType, attachment.name)) return materializeImage(msgDir, attachment);
  if (isPdf(attachment.contentType, attachment.name)) return materializePdf(msgDir, attachment);
  if (isTextLike(attachment.contentType, attachment.name)) return materializeText(msgDir, attachment);
  return null;
}

/**
 * Rewrites a message's content so any attachment references point at local files instead of the
 * surface's own (often already-expired) URLs. Both the detection of which attachments to fetch and
 * the reference-rewriting are delegated to the surface's `AttachmentSource` — this stays neutral,
 * doing only the download + pdf/image materialization.
 *
 * Never throws: any failure (deleted message, lost access, missing pdftotext/pdftoppm, a single
 * attachment's download failing) degrades to leaving the affected reference(s) as-is rather than
 * failing the whole sweep.
 */
export async function materializeMessageAttachments(
  source: AttachmentSource,
  attachmentsDir: string,
  message: WikiSyncMessage,
): Promise<string> {
  let attachments: FetchedAttachment[];
  try {
    attachments = await source.attachmentsFor(message);
  } catch (err) {
    logger.warn({ err, channelId: message.channelId, messageId: message.messageId }, "failed to fetch message attachments");
    return message.content;
  }

  if (attachments.length === 0) {
    return message.content;
  }

  const msgDir = join(attachmentsDir, message.messageId);
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
  return source.rewriteAttachmentLinks(message.content, replacements);
}
