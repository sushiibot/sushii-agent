// Raster sniffing, dimension reading and metadata stripping for web uploads, without decoding pixels.
// Formats: PNG (W3C PNG 3rd ed.), JPEG (ITU T.81 annex B), GIF89a, WebP (RFC 9649, VP8 per RFC 6386).

export type ImageType = "png" | "jpeg" | "gif" | "webp";

export const IMAGE_MIME: Record<ImageType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Decoded-size ceiling, read from the header before anything is stored. */
export const MAX_PIXELS = 50_000_000;

export interface ProcessedImage {
  type: ImageType;
  /** The re-serialized file with metadata segments and any trailing bytes removed. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, at: number, len: number): string {
  if (b.length < at + len) return "";
  return String.fromCharCode(...b.subarray(at, at + len));
}

/** The raster type the magic bytes name, or null. Anything else (SVG, HTML, PDF, ...) is not an image here. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (startsWith(b, PNG_SIG)) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  const gif = ascii(b, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return null;
}

/** Sniffs, measures and strips metadata. Null when the type is not allowlisted, the structure does not
 *  parse, or the dimensions are unreadable, zero or over MAX_PIXELS: callers must not serve such bytes inline. */
export function processImage(b: Uint8Array): ProcessedImage | null {
  const type = sniffImageType(b);
  if (!type) return null;
  let out: Omit<ProcessedImage, "type"> | null;
  try {
    out = type === "png" ? stripPng(b) : type === "jpeg" ? stripJpeg(b) : type === "gif" ? stripGif(b) : stripWebp(b);
  } catch {
    return null;
  }
  if (!out || out.width <= 0 || out.height <= 0 || out.width * out.height > MAX_PIXELS) return null;
  return { type, ...out };
}

class Out {
  private parts: Uint8Array[] = [];
  push(b: Uint8Array): void {
    this.parts.push(b);
  }
  bytes(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + ((b[i + 3]! << 24) >>> 0);

// ── PNG ──

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(b: Uint8Array): Omit<ProcessedImage, "type"> | null {
  const out = new Out();
  out.push(b.subarray(0, 8));
  let i = 8;
  let width = 0;
  let height = 0;
  let first = true;
  for (;;) {
    if (i + 12 > b.length) return null;
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (first) {
      if (type !== "IHDR" || len !== 13) return null;
      width = u32be(b, i + 8);
      height = u32be(b, i + 12);
      first = false;
    }
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return { bytes: out.bytes(), width, height };
}

// ── JPEG ──

function keepJpegSegment(marker: number, b: Uint8Array, dataAt: number, dataLen: number): boolean {
  if (marker === 0xe0) return true; // JFIF
  if (marker === 0xee) return true; // Adobe color transform, needed to decode some files
  if (marker === 0xe2) return dataLen >= 12 && ascii(b, dataAt, 12) === "ICC_PROFILE\0";
  if (marker >= 0xe1 && marker <= 0xef) return false; // Exif, XMP, MPF, IPTC and other APPn
  return marker !== 0xfe; // COM
}

const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function stripJpeg(b: Uint8Array): Omit<ProcessedImage, "type"> | null {
  const out = new Out();
  out.push(b.subarray(0, 2));
  let i = 2;
  let width = 0;
  let height = 0;
  let sof = false;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i]!;
    i++;
    if (marker === 0xd9) {
      out.push(new Uint8Array([0xff, 0xd9]));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(new Uint8Array([0xff, marker]));
      continue;
    }
    if (i + 2 > b.length) return null;
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return null;
    const segStart = i - 2;
    const segEnd = i + len;
    if (isSof(marker)) {
      if (len < 7) return null;
      height = u16be(b, i + 3);
      width = u16be(b, i + 5);
      sof = true;
    }
    if (marker === 0xda) {
      if (!sof) return null;
      // Entropy-coded data runs to the next marker other than a stuffed 0x00 or a restart marker.
      let j = segEnd;
      for (;;) {
        if (j + 1 >= b.length) return null;
        if (b[j] === 0xff) {
          const next = b[j + 1]!;
          if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        j++;
      }
      out.push(b.subarray(segStart, j));
      i = j;
      continue;
    }
    if (keepJpegSegment(marker, b, i + 2, len - 2)) out.push(b.subarray(segStart, segEnd));
    i = segEnd;
  }
  if (!sof) return null;
  return { bytes: out.bytes(), width, height };
}

// ── GIF ──

function gifSubBlocksEnd(b: Uint8Array, i: number): number {
  for (;;) {
    if (i >= b.length) throw new Error("truncated gif");
    const n = b[i]!;
    i += 1 + n;
    if (n === 0) return i;
  }
}

function stripGif(b: Uint8Array): Omit<ProcessedImage, "type"> | null {
  if (b.length < 13) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const packed = b[10]!;
  let i = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  if (i > b.length) return null;
  const out = new Out();
  out.push(b.subarray(0, i));
  let frames = 0;
  for (;;) {
    if (i >= b.length) return null;
    const block = b[i]!;
    if (block === 0x3b) {
      out.push(new Uint8Array([0x3b]));
      break;
    }
    if (block === 0x2c) {
      if (i + 10 > b.length) return null;
      const fw = u16le(b, i + 5);
      const fh = u16le(b, i + 7);
      if (fw * fh > MAX_PIXELS) return null;
      const p = b[i + 9]!;
      const dataAt = i + 10 + (p & 0x80 ? 3 * (1 << ((p & 7) + 1)) : 0) + 1;
      const end = gifSubBlocksEnd(b, dataAt);
      out.push(b.subarray(i, end));
      i = end;
      frames++;
      continue;
    }
    if (block === 0x21) {
      if (i + 2 > b.length) return null;
      const label = b[i + 1]!;
      const end = gifSubBlocksEnd(b, i + 2);
      const app = label === 0xff ? ascii(b, i + 3, 11) : "";
      const keep = label === 0xf9 || app === "NETSCAPE2.0" || app === "ANIMEXTS1.0";
      if (keep) out.push(b.subarray(i, end));
      i = end;
      continue;
    }
    return null;
  }
  if (frames === 0) return null;
  return { bytes: out.bytes(), width, height };
}

// ── WebP ──

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ICCP", "ANIM", "ANMF", "ALPH"]);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(b: Uint8Array): Omit<ProcessedImage, "type"> | null {
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length || riffEnd < 12) return null;
  const chunks: Uint8Array[] = [];
  let i = 12;
  let width = 0;
  let height = 0;
  let sized = false;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) return null;
    const fourcc = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    const dataAt = i + 8;
    const end = dataAt + len + (len & 1);
    if (dataAt + len > riffEnd) return null;
    if (fourcc === "VP8X") {
      if (len < 10) return null;
      const chunk = new Uint8Array(b.subarray(i, dataAt + len + (len & 1)));
      chunk[8] = chunk[8]! & ~(VP8X_EXIF | VP8X_XMP);
      chunks.push(chunk);
      width = u24le(b, dataAt + 4) + 1;
      height = u24le(b, dataAt + 7) + 1;
      sized = true;
    } else {
      if (!sized && fourcc === "VP8 ") {
        if (len < 10 || !startsWith(b, [0x9d, 0x01, 0x2a], dataAt + 3)) return null;
        width = u16le(b, dataAt + 6) & 0x3fff;
        height = u16le(b, dataAt + 8) & 0x3fff;
        sized = true;
      } else if (!sized && fourcc === "VP8L") {
        if (len < 5 || b[dataAt] !== 0x2f) return null;
        const bits = u32le(b, dataAt + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        sized = true;
      }
      if (WEBP_KEEP.has(fourcc)) chunks.push(b.subarray(i, Math.min(end, riffEnd)));
    }
    i = end;
  }
  if (!sized) return null;
  const body = Buffer.concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  return { bytes: new Uint8Array(Buffer.concat([header, body])), width, height };
}
