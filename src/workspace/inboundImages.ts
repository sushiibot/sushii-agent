import type { ImageContent } from "@earendil-works/pi-ai";
import type { ChatMessageParams } from "../orchestration/contracts.ts";
import { getLogger } from "../logger.ts";

const log = getLogger("workspace.images");

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
export const IMAGES_PER_MESSAGE_MAX = 10;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Attachment = NonNullable<ChatMessageParams["attachments"]>[number];

export interface ImageFetchOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  maxBytes?: number;
  timeoutMs?: number;
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

async function fetchImage(a: Attachment, opts: ImageFetchOptions): Promise<ImageContent | null> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES;
  try {
    const res = await doFetch(a.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS) });
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
  const images = (attachments ?? []).filter(isImageAttachment).slice(0, IMAGES_PER_MESSAGE_MAX);
  const loaded = await Promise.all(images.map((a) => fetchImage(a, opts)));
  return loaded.filter((i): i is ImageContent => i !== null);
}

/** Whether the model accepts image input; a session that doesn't say (a test fake) is assumed to. */
export function acceptsImages(session: unknown): boolean {
  const input = (session as { model?: { input?: unknown } } | null)?.model?.input;
  return !Array.isArray(input) || input.includes("image");
}
