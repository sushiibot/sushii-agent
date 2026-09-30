// Synthetic image files for the upload tests: structurally valid headers and containers, junk pixel data.

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(Buffer.concat(parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)))));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

export const SECRET = "GPS-SECRET-51.5N";

export function pngChunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  return cat(be32(d.length), enc(type), d, [0, 0, 0, 0]);
}

export function png(w: number, h: number, opts: { meta?: boolean; tail?: string } = {}): Uint8Array {
  return cat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
    ...(opts.meta ? [pngChunk("eXIf", enc(`MM\0*${SECRET}`)), pngChunk("tEXt", enc(`Comment\0${SECRET}`))] : []),
    pngChunk("IDAT", [1, 2, 3, 4]),
    pngChunk("IEND", []),
    enc(opts.tail ?? ""),
  );
}

export function jpegSeg(marker: number, data: Uint8Array | number[]): Uint8Array {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  return cat([0xff, marker], be16(d.length + 2), d);
}

export function jpeg(w: number, h: number, opts: { meta?: boolean; sof?: boolean; eoi?: boolean; tail?: string } = {}): Uint8Array {
  return cat(
    [0xff, 0xd8],
    jpegSeg(0xe0, enc("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...(opts.meta ? [jpegSeg(0xe1, enc(`Exif\0\0${SECRET}`)), jpegSeg(0xfe, enc(SECRET)), jpegSeg(0xe2, enc(`MPF\0${SECRET}`))] : []),
    jpegSeg(0xe2, enc("ICC_PROFILE\0\x01\x01icc")),
    ...(opts.sof === false ? [] : [jpegSeg(0xc0, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0])]),
    jpegSeg(0xda, [1, 1, 0, 0, 63, 0]),
    [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56],
    opts.eoi === false ? [] : [0xff, 0xd9],
    enc(opts.tail ?? ""),
  );
}

export function gif(w: number, h: number, opts: { meta?: boolean } = {}): Uint8Array {
  const sub = (s: string) => cat([s.length], enc(s));
  return cat(
    enc("GIF89a"),
    [...le16(w), ...le16(h), 0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    ...(opts.meta ? [cat([0x21, 0xfe], sub(SECRET), [0]), cat([0x21, 0xff], sub("XMP DataXMP"), sub(SECRET), [0])] : []),
    cat([0x21, 0xff], sub("NETSCAPE2.0"), [3, 1, 0, 0, 0]),
    [0x21, 0xf9, 4, 0, 0, 0, 0, 0],
    [0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0],
    [2, 2, 0x4c, 0x01, 0],
    [0x3b],
    enc(SECRET),
  );
}

export function riffChunk(fourcc: string, data: Uint8Array | number[]): Uint8Array {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  return cat(enc(fourcc), le32(d.length), d, d.length & 1 ? [0] : []);
}

export const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const ihdr = (w: number, h: number) => pngChunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
export const actl = (frames: number) => pngChunk("acTL", [...be32(frames), 0, 0, 0, 0]);
export const fctl = (seq: number, w: number, h: number, x = 0, y = 0) =>
  pngChunk("fcTL", [...be32(seq), ...be32(w), ...be32(h), ...be32(x), ...be32(y), 0, 1, 0, 10, 0, 0]);
export const pngFile = (...chunks: Uint8Array[]) => cat(PNG_SIG, ...chunks);

export const jpegFile = (...segs: Uint8Array[]) => cat([0xff, 0xd8], ...segs, jpegSeg(0xda, [1, 1, 0, 0, 63, 0]), [0x12, 0x34, 0xff, 0xd9]);
export const sof0 = (w: number, h: number) => jpegSeg(0xc0, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]);

export const vp8 = (w: number, h: number) => riffChunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
export const vp8l = (w: number, h: number) => riffChunk("VP8L", [0x2f, ...le32(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)), 0, 0]);
export const vp8x = (w: number, h: number, flags = 0) => riffChunk("VP8X", [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
export const anmf = (w: number, h: number, bitstream: Uint8Array, x = 0, y = 0) =>
  riffChunk("ANMF", cat(le24(x / 2), le24(y / 2), le24(w - 1), le24(h - 1), le24(100), [0], bitstream));
export function webpFile(...chunks: Uint8Array[]): Uint8Array {
  const body = cat(enc("WEBP"), ...chunks);
  return cat(enc("RIFF"), le32(body.length), body);
}

export function gifFrames(screenW: number, screenH: number, frames: { w: number; h: number; x?: number; y?: number }[]): Uint8Array {
  return cat(
    enc("GIF89a"),
    [...le16(screenW), ...le16(screenH), 0, 0, 0],
    ...frames.map((f) => cat([0x2c, ...le16(f.x ?? 0), ...le16(f.y ?? 0), ...le16(f.w), ...le16(f.h), 0], [2, 1, 0x44, 0])),
    [0x3b],
  );
}

export function webp(w: number, h: number, opts: { meta?: boolean; lossy?: boolean } = {}): Uint8Array {
  const bitstream = opts.lossy
    ? riffChunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0])
    : riffChunk("VP8L", [0x2f, ...le32(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)), 0, 0]);
  const chunks = opts.meta
    ? [riffChunk("VP8X", [0x0c, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]), bitstream, riffChunk("EXIF", enc(`${SECRET}x`)), riffChunk("XMP ", enc(SECRET))]
    : [bitstream];
  const body = cat(enc("WEBP"), ...chunks);
  return cat(enc("RIFF"), le32(body.length), body);
}

export const SVG = enc(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>`);
export const HTML = enc(`<!doctype html><script>alert(document.domain)</script>`);

export function contains(hay: Uint8Array, needle: string): boolean {
  return Buffer.from(hay).includes(Buffer.from(needle));
}
