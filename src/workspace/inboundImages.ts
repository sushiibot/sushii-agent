import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { RPC_METHODS, base64Bytes, parseUploadUrl, uploadReadResult, type ChatMessageParams } from "../orchestration/contracts.ts";
import { getLogger } from "../logger.ts";

const log = getLogger("workspace.images");

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Under the bot's 10s chat/message timeout: the download is awaited before the message is acked.
export const IMAGE_FETCH_TIMEOUT_MS = 7_000;
export const IMAGES_PER_MESSAGE_MAX = 10;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type Attachment = NonNullable<ChatMessageParams["attachments"]>[number];

export interface ImageFetchOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  maxBytes?: number;
  timeoutMs?: number;
  /** Resizes a steer's images; tests inject it. Default Pi's resizeImage. */
  resize?: ResizeFn;
}

export function isImageAttachment(a: Pick<Attachment, "contentType">): boolean {
  return IMAGE_TYPES.has(a.contentType.split(";")[0]!.trim().toLowerCase());
}

/** The image type the bytes actually are; a declared type the provider would reject poisons the session. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && String.fromCharCode(...b.subarray(0, 6)).match(/^GIF8[79]a$/)) return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Only Discord's CDN over https: the URL comes over the wire, and the fetch runs inside the workspace's network. */
export function isAllowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && IMAGE_HOSTS.has(u.hostname) && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}

async function fetchImage(a: Attachment, opts: ImageFetchOptions): Promise<ImageContent | null> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES;
  if (!isAllowedImageUrl(a.url)) {
    log.info({ name: a.name }, "image attachment isn't on Discord's CDN; passing it as a link only");
    return null;
  }
  try {
    // A redirect could point anywhere, so none is followed.
    const res = await doFetch(a.url, { redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await readCapped(res, maxBytes);
    if (!bytes) {
      log.info({ name: a.name, maxBytes }, "image attachment over the size cap; passing it as a link only");
      return null;
    }
    const mimeType = sniffImageType(bytes);
    if (!mimeType) {
      log.info({ name: a.name, declared: a.contentType }, "image attachment isn't a PNG/JPEG/GIF/WEBP; passing it as a link only");
      return null;
    }
    return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
  } catch (err) {
    log.warn({ err, name: a.name }, "downloading an image attachment failed; passing it as a link only");
    return null;
  }
}

/** The message's image attachments as model input; a failed or oversized download is left out, never thrown. */
export async function loadImageAttachments(attachments: readonly Attachment[] | undefined, opts: ImageFetchOptions = {}): Promise<ImageContent[]> {
  const images = (attachments ?? []).filter((a) => isImageAttachment(a) && parseUploadUrl(a.url) === null).slice(0, IMAGES_PER_MESSAGE_MAX);
  const loaded = await Promise.all(images.map((a) => fetchImage(a, opts)));
  return loaded.filter((i): i is ImageContent => i !== null);
}

/** Whether the model accepts image input; a session that doesn't say (a test fake) is assumed to. */
export function acceptsImages(session: unknown): boolean {
  const input = (session as { model?: { input?: unknown } } | null)?.model?.input;
  return !Array.isArray(input) || input.includes("image");
}

// Under the strictest provider's per-image cap (Anthropic: 5 MB of base64); used only when resizing fails.
export const STEER_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;
const OMITTED_HINT = "[Image omitted: could not be resized below the inline image size limit.]";

export type ResizeFn = typeof resizeImage;

/** A steer's images resized the way Pi resizes a prompt's (Pi queues a steer's images as they are), with
 *  Pi's notes appended to the text the same way. An oversized image left in history fails every later request. */
export async function prepareSteerImages(
  text: string,
  images: readonly ImageContent[],
  resize: ResizeFn = resizeImage,
): Promise<{ text: string; images: ImageContent[] }> {
  const out: ImageContent[] = [];
  const hints: string[] = [];
  for (const image of images) {
    try {
      const resized = await resize(Buffer.from(image.data, "base64"), image.mimeType);
      if (!resized) {
        hints.push(OMITTED_HINT);
        continue;
      }
      out.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
      const note = formatDimensionNote(resized);
      if (note) hints.push(note);
    } catch (err) {
      log.warn({ err }, "resizing a steered image failed; keeping it only if it is small");
      if (base64Bytes(image.data) <= STEER_IMAGE_MAX_BYTES) out.push(image);
      else hints.push(OMITTED_HINT);
    }
  }
  return { text: hints.length ? `${text}\n\n${hints.join("\n")}` : text, images: out };
}

/** Owner uploads land in `~/uploads`, so the agent can open them again later. */
export const UPLOADS_DIR = "uploads";
const UPLOAD_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** `<id>.<ext>`, the extension from the bot's declared type. The id is the bot's 22-char upload id. */
export function uploadFileName(uploadId: string, contentType: string): string {
  return `${uploadId}.${UPLOAD_EXT[contentType.split(";")[0]!.trim().toLowerCase()] ?? "bin"}`;
}

export interface UploadFetchOptions {
  principalId: string;
  /** Absolute path of `~/uploads`. */
  dir: string;
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  timeoutMs?: number;
}

/**
 * Pulls each `upload:<id>` attachment's bytes from the bot over upload/read and writes them to
 * `<dir>/<id>.<ext>`. Returns the ids actually written, and the ones that are images as model input when
 * `images` is set; a failure leaves that attachment out and is never thrown.
 */
export async function loadUploadAttachments(
  attachments: readonly Attachment[] | undefined,
  opts: UploadFetchOptions,
  images: boolean,
): Promise<{ images: ImageContent[]; saved: Set<string> }> {
  const uploads = (attachments ?? [])
    .map((a) => ({ a, id: parseUploadUrl(a.url) }))
    .filter((u): u is { a: Attachment; id: string } => u.id !== null)
    .slice(0, IMAGES_PER_MESSAGE_MAX);
  const loaded = await Promise.all(uploads.map((u) => fetchUpload(u.a, u.id, opts, images)));
  const saved = new Set<string>();
  const out: ImageContent[] = [];
  for (const [i, r] of loaded.entries()) {
    if (r.saved) saved.add(uploads[i]!.id);
    if (r.image) out.push(r.image);
  }
  return { images: out, saved };
}

async function fetchUpload(a: Attachment, uploadId: string, opts: UploadFetchOptions, images: boolean): Promise<{ saved: boolean; image: ImageContent | null }> {
  let saved = false;
  try {
    const res = uploadReadResult.parse(
      await opts.request(RPC_METHODS.uploadRead, { principalId: opts.principalId, uploadId }, opts.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS),
    );
    if (!res.ok) {
      log.info({ uploadId, error: res.error }, "the bot refused an upload's bytes; passing it as a note only");
      return { saved, image: null };
    }
    const bytes = Buffer.from(res.dataBase64, "base64");
    writeUpload(opts.dir, uploadFileName(uploadId, a.contentType), bytes);
    saved = true;
    if (!images) return { saved, image: null };
    const mimeType = sniffImageType(bytes);
    if (!mimeType) {
      log.info({ uploadId, declared: a.contentType }, "upload isn't a PNG/JPEG/GIF/WEBP; saved to disk only");
      return { saved, image: null };
    }
    return { saved, image: { type: "image", data: res.dataBase64, mimeType } };
  } catch (err) {
    log.warn({ err, uploadId }, "fetching an upload's bytes failed; passing it as a note only");
    return { saved, image: null };
  }
}

/**
 * `dir` must be a real directory where it says it is: a symlink there (the agent owns home) would steer
 * the write into its target. Checked again before the rename; a swap in between remains possible.
 */
function assertRealDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} isn't a plain directory`);
  if (realpathSync(dir) !== join(realpathSync(dirname(dir)), basename(dir))) throw new Error(`${dir} resolves somewhere else`);
}

// Rename replaces the directory entry, so a symlink the agent left at the final name is never followed.
function writeUpload(dir: string, name: string, bytes: Uint8Array): void {
  try {
    mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  assertRealDir(dir);
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    assertRealDir(dir);
    renameSync(tmp, join(dir, name));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
