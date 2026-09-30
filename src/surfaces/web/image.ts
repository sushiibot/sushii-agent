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
/** Animation frame ceiling across GIF, APNG and animated WebP. */
export const MAX_FRAMES = 1000;

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

// Critical chunks plus the ancillaries that change how pixels render; everything else (text, Exif, C2PA, private) goes.
const PNG_KEEP = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "cICP", "mDCv", "cLLI", "pHYs",
  "acTL", "fcTL", "fdAT",
]);

function stripPng(b: Uint8Array): Omit<ProcessedImage, "type"> | null {
  const out = new Out();
  out.push(b.subarray(0, 8));
  let i = 8;
  let width = 0;
  let height = 0;
  let first = true;
  let frames = 0;
  for (;;) {
    if (i + 12 > b.length) return null;
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) return null;
    const at = i + 8;
    if (first) {
      if (type !== "IHDR" || len !== 13) return null;
      width = u32be(b, at);
      height = u32be(b, at + 4);
      first = false;
    } else if (type === "IHDR") return null;
    if (type === "acTL") {
      if (len !== 8 || u32be(b, at) > MAX_FRAMES) return null;
    } else if (type === "fcTL") {
      if (len !== 26 || ++frames > MAX_FRAMES) return null;
      const fw = u32be(b, at + 4);
      const fh = u32be(b, at + 8);
      if (fw === 0 || fh === 0 || u32be(b, at + 12) + fw > width || u32be(b, at + 16) + fh > height) return null;
    }
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return { bytes: out.bytes(), width, height };
}

// ── JPEG ──

const JFIF_LEN = 14; // "JFIF\0", version, units, x and y density, thumbnail width and height
const ADOBE_LEN = 12; // "Adobe", version, flags0, flags1, transform

/** The segment to write back for a non-SOS marker, or null to drop it. APP0 and APP14 are cut to their fixed
 *  headers, so a JFIF thumbnail or trailing payload never survives. */
function keptJpegSegment(marker: number, b: Uint8Array, dataAt: number, dataLen: number): Uint8Array | null {
  const seg = () => b.subarray(dataAt - 4, dataAt + dataLen);
  if (isSof(marker) || marker === 0xc4 || marker === 0xcc || marker === 0xdb || marker === 0xdd) return seg();
  if (marker === 0xe2) return dataLen >= 12 && ascii(b, dataAt, 12) === "ICC_PROFILE\0" ? seg() : null;
  if (marker === 0xe0) {
    if (dataLen < JFIF_LEN || ascii(b, dataAt, 5) !== "JFIF\0") return null;
    const s = new Uint8Array([0xff, 0xe0, 0, JFIF_LEN + 2, ...b.subarray(dataAt, dataAt + JFIF_LEN)]);
    s[s.length - 2] = 0;
    s[s.length - 1] = 0;
    return s;
  }
  if (marker === 0xee) {
    if (dataLen < ADOBE_LEN || ascii(b, dataAt, 5) !== "Adobe") return null;
    return new Uint8Array([0xff, 0xee, 0, ADOBE_LEN + 2, ...b.subarray(dataAt, dataAt + ADOBE_LEN)]);
  }
  return null;
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
      if (sof || len < 7) return null;
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
    const kept = keptJpegSegment(marker, b, i + 2, len - 2);
    if (kept) out.push(kept);
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
  const screenW = u16le(b, 6);
  const screenH = u16le(b, 8);
  // Decoders grow the canvas to fit a first frame that overhangs the logical screen, so that is the size reported.
  let width = screenW;
  let height = screenH;
  let extentW = screenW;
  let extentH = screenH;
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
      if (i + 10 > b.length || ++frames > MAX_FRAMES) return null;
      const right = u16le(b, i + 1) + u16le(b, i + 5);
      const bottom = u16le(b, i + 3) + u16le(b, i + 7);
      extentW = Math.max(extentW, right);
      extentH = Math.max(extentH, bottom);
      if (extentW * extentH > MAX_PIXELS) return null;
      if (frames === 1) {
        width = Math.max(width, right);
        height = Math.max(height, bottom);
      }
      const p = b[i + 9]!;
      const dataAt = i + 10 + (p & 0x80 ? 3 * (1 << ((p & 7) + 1)) : 0) + 1;
      const end = gifSubBlocksEnd(b, dataAt);
      out.push(b.subarray(i, end));
      i = end;
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
const VP8X_ANIM = 0x02;

interface RiffChunk {
  fourcc: string;
  dataAt: number;
  len: number;
  /** Past the chunk's padding, clamped to the parent's end. */
  end: number;
}

function riffChunks(b: Uint8Array, from: number, to: number): RiffChunk[] | null {
  const chunks: RiffChunk[] = [];
  let i = from;
  while (i < to) {
    if (i + 8 > to) return null;
    const len = u32le(b, i + 4);
    const dataAt = i + 8;
    if (dataAt + len > to) return null;
    chunks.push({ fourcc: ascii(b, i, 4), dataAt, len, end: Math.min(dataAt + len + (len & 1), to) });
    i = dataAt + len + (len & 1);
  }
  return chunks;
}

/** Dimensions a VP8 or VP8L bitstream decodes to, or null if it is not one or its header is malformed. */
function bitstreamSize(b: Uint8Array, c: RiffChunk): { w: number; h: number } | null {
  if (c.fourcc === "VP8 ") {
    if (c.len < 10 || !startsWith(b, [0x9d, 0x01, 0x2a], c.dataAt + 3)) return null;
    return { w: u16le(b, c.dataAt + 6) & 0x3fff, h: u16le(b, c.dataAt + 8) & 0x3fff };
  }
  if (c.fourcc === "VP8L") {
    if (c.len < 5 || b[c.dataAt] !== 0x2f) return null;
    const bits = u32le(b, c.dataAt + 1);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

const isBitstream = (c: RiffChunk) => c.fourcc === "VP8 " || c.fourcc === "VP8L";

/** Checks one ANMF frame fits the canvas and that its bitstream decodes to the frame size it declares. */
function validAnmf(b: Uint8Array, c: RiffChunk, canvasW: number, canvasH: number): boolean {
  if (c.len < 16) return false;
  const x = 2 * u24le(b, c.dataAt);
  const y = 2 * u24le(b, c.dataAt + 3);
  const w = u24le(b, c.dataAt + 6) + 1;
  const h = u24le(b, c.dataAt + 9) + 1;
  if (x + w > canvasW || y + h > canvasH) return false;
  const inner = riffChunks(b, c.dataAt + 16, c.dataAt + c.len);
  const bits = inner?.filter(isBitstream);
  if (!bits || bits.length !== 1) return false;
  const size = bitstreamSize(b, bits[0]!);
  return size !== null && size.w === w && size.h === h;
}

function stripWebp(b: Uint8Array): Omit<ProcessedImage, "type"> | null {
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length || riffEnd < 12) return null;
  const chunks = riffChunks(b, 12, riffEnd);
  if (!chunks?.length) return null;
  const first = chunks[0]!;
  // RFC 9649 2.7: VP8X leads an extended file; browsers ignore one anywhere else and size from the bitstream.
  if (chunks.some((c, n) => n > 0 && c.fourcc === "VP8X")) return null;
  const bitstreams = chunks.filter(isBitstream);
  let width: number;
  let height: number;
  const kept: Uint8Array[] = [];
  if (first.fourcc !== "VP8X") {
    const size = bitstreamSize(b, first);
    if (!size || bitstreams.length !== 1 || chunks.some((c) => c.fourcc === "ANMF")) return null;
    width = size.w;
    height = size.h;
  } else {
    if (first.len < 10) return null;
    const flags = b[first.dataAt]!;
    width = u24le(b, first.dataAt + 4) + 1;
    height = u24le(b, first.dataAt + 7) + 1;
    if (flags & VP8X_ANIM) {
      const frames = chunks.filter((c) => c.fourcc === "ANMF");
      if (bitstreams.length || !frames.length || frames.length > MAX_FRAMES) return null;
      if (!frames.every((f) => validAnmf(b, f, width, height))) return null;
    } else {
      if (bitstreams.length !== 1 || chunks.some((c) => c.fourcc === "ANMF")) return null;
      const size = bitstreamSize(b, bitstreams[0]!);
      if (!size || size.w !== width || size.h !== height) return null;
    }
    const vp8x = new Uint8Array(b.subarray(12, first.end));
    vp8x[8] = vp8x[8]! & ~(VP8X_EXIF | VP8X_XMP);
    kept.push(vp8x);
  }
  for (const c of chunks.slice(first.fourcc === "VP8X" ? 1 : 0)) if (WEBP_KEEP.has(c.fourcc)) kept.push(b.subarray(c.dataAt - 8, c.end));
  const body = Buffer.concat(kept);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, 4 + body.length, true);
  return { bytes: new Uint8Array(Buffer.concat([header, body])), width, height };
}
