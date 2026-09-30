import { describe, expect, test } from "bun:test";
import {
  HTML, SECRET, SVG, actl, anmf, contains, fctl, gif, gifFrames, ihdr, jpeg, jpegFile, jpegSeg, png, pngChunk, pngFile, riffChunk, sof0, vp8, vp8l, vp8x, webp, webpFile,
} from "./__fixtures__/images.ts";
import { MAX_FRAMES, MAX_PIXELS, processImage, sniffImageType } from "./image.ts";

describe("sniffImageType", () => {
  test.each([
    ["png", png(1, 1)],
    ["jpeg", jpeg(1, 1)],
    ["gif", gif(1, 1)],
    ["webp", webp(1, 1)],
  ] as const)("%s", (type, bytes) => expect(sniffImageType(bytes)).toBe(type));

  test.each([
    ["svg", SVG],
    ["html", HTML],
    ["empty", new Uint8Array(0)],
    ["pdf", new TextEncoder().encode("%PDF-1.7\n")],
    ["RIFF but not WEBP", new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ")],
  ])("rejects %s", (_, bytes) => expect(sniffImageType(bytes)).toBeNull());
});

describe("processImage strips metadata and keeps the image parseable", () => {
  test.each([
    ["png", png(640, 480, { meta: true, tail: "<script>alert(1)</script>" })],
    ["jpeg", jpeg(640, 480, { meta: true, tail: `MOTIONPHOTO${SECRET}` })],
    ["gif", gif(640, 480, { meta: true })],
    ["webp", webp(640, 480, { meta: true })],
  ] as const)("%s", (type, bytes) => {
    expect(contains(bytes, SECRET)).toBe(true);
    const out = processImage(bytes)!;
    expect(out).not.toBeNull();
    expect(out.type).toBe(type);
    expect([out.width, out.height]).toEqual([640, 480]);
    expect(contains(out.bytes, SECRET)).toBe(false);
    expect(contains(out.bytes, "<script>")).toBe(false);
    const again = processImage(out.bytes)!;
    expect([again.type, again.width, again.height]).toEqual([type, 640, 480]);
    expect(Buffer.from(again.bytes).equals(Buffer.from(out.bytes))).toBe(true);
  });

  test("jpeg keeps the ICC profile but drops MPF", () => {
    const out = processImage(jpeg(10, 10, { meta: true }))!;
    expect(contains(out.bytes, "ICC_PROFILE")).toBe(true);
    expect(contains(out.bytes, "MPF")).toBe(false);
  });

  test("webp clears the VP8X Exif and XMP flags and fixes the RIFF size", () => {
    const out = processImage(webp(10, 10, { meta: true }))!;
    const b = Buffer.from(out.bytes);
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    const vp8x = b.indexOf("VP8X");
    expect(b[vp8x + 8]! & 0x0c).toBe(0);
  });

  test("lossy webp dimensions", () => {
    const out = processImage(webp(300, 200, { lossy: true }))!;
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  test("gif keeps the loop extension and drops comments", () => {
    const out = processImage(gif(4, 4, { meta: true }))!;
    expect(contains(out.bytes, "NETSCAPE2.0")).toBe(true);
    expect(contains(out.bytes, "XMP Data")).toBe(false);
  });
});

describe("processImage fails closed", () => {
  test.each([
    ["jpeg without SOF", jpeg(10, 10, { sof: false })],
    ["jpeg without EOI", jpeg(10, 10, { eoi: false })],
    ["jpeg with zero height", jpeg(10, 0)],
    ["truncated png", png(10, 10).subarray(0, 30)],
    ["png over the pixel cap", png(10_000, 10_000)],
    ["jpeg over the pixel cap", jpeg(65_000, 65_000)],
    ["webp over the pixel cap", webp(16_000, 16_000, { meta: true })],
    ["gif over the pixel cap", gif(65_000, 65_000)],
    ["truncated gif", gif(10, 10).subarray(0, 20)],
    ["svg", SVG],
    ["html", HTML],
  ])("%s", (_, bytes) => expect(processImage(bytes)).toBeNull());

  test("exactly at the pixel cap is allowed", () => {
    expect(processImage(png(MAX_PIXELS / 5000, 5000))).not.toBeNull();
  });
});

const enc = (t: string) => new TextEncoder().encode(t);
const idat = pngChunk("IDAT", [1, 2, 3, 4]);
const iend = pngChunk("IEND", []);

describe("the measured size is the size a browser decodes", () => {
  test("webp: a VP8X after the bitstream can't shrink a 268 MP image to 1x1", () => {
    expect(processImage(webpFile(vp8(16383, 16383), vp8x(1, 1)))).toBeNull();
    expect(processImage(webpFile(vp8l(100, 100), vp8x(1, 1)))).toBeNull();
  });

  test("webp: a still's bitstream must match the VP8X canvas", () => {
    expect(processImage(webpFile(vp8x(1, 1), vp8(8000, 8000)))).toBeNull();
    expect(processImage(webpFile(vp8x(8000, 8000), vp8l(1, 1)))).toBeNull();
    expect(processImage(webpFile(vp8x(40, 30), vp8(40, 30)))).toMatchObject({ width: 40, height: 30 });
  });

  test("webp: a simple file must start with its bitstream and hold exactly one", () => {
    expect(processImage(webpFile(riffChunk("JUNK", [0, 0]), vp8(10, 10)))).toBeNull();
    expect(processImage(webpFile(vp8(1, 1), vp8(8000, 8000)))).toBeNull();
    expect(processImage(webpFile(vp8x(10, 10), vp8(10, 10), vp8(10, 10)))).toBeNull();
  });

  test("webp animation: frames fit the canvas and decode to their declared size", () => {
    const ok = webpFile(vp8x(20, 20, 0x02), riffChunk("ANIM", [0, 0, 0, 0, 0, 0]), anmf(10, 10, vp8l(10, 10)), anmf(10, 10, vp8(10, 10), 10, 10));
    expect(processImage(ok)).toMatchObject({ width: 20, height: 20 });
    expect(processImage(webpFile(vp8x(20, 20, 0x02), anmf(10, 10, vp8(10, 10), 12, 0)))).toBeNull();
    expect(processImage(webpFile(vp8x(20, 20, 0x02), anmf(10, 10, vp8(8000, 8000))))).toBeNull();
    expect(processImage(webpFile(vp8x(20, 20, 0x02), vp8(20, 20)))).toBeNull();
    expect(processImage(webpFile(vp8x(20, 20), anmf(10, 10, vp8(10, 10))))).toBeNull();
    const withMeta = Buffer.concat([riffChunk("EXIF", enc(SECRET)), vp8(10, 10)]);
    expect(processImage(webpFile(vp8x(20, 20, 0x02), anmf(10, 10, new Uint8Array(withMeta))))).toBeNull();
  });

  test("png: a second IHDR or an APNG frame outside the canvas is rejected", () => {
    expect(processImage(pngFile(ihdr(10, 10), idat, iend))).toMatchObject({ width: 10, height: 10 });
    expect(processImage(pngFile(ihdr(1, 1), ihdr(8000, 8000), idat, iend))).toBeNull();
    expect(processImage(pngFile(ihdr(10, 10), actl(1), fctl(0, 10, 10), idat, iend))).not.toBeNull();
    expect(processImage(pngFile(ihdr(10, 10), actl(1), fctl(0, 8000, 8000), idat, iend))).toBeNull();
    expect(processImage(pngFile(ihdr(10, 10), actl(1), fctl(0, 5, 5, 6, 0), idat, iend))).toBeNull();
  });

  test("jpeg: a second SOF is rejected, not trusted", () => {
    expect(processImage(jpegFile(sof0(65535, 65535), sof0(1, 1)))).toBeNull();
    expect(processImage(jpegFile(sof0(12, 8)))).toMatchObject({ width: 12, height: 8 });
  });

  test("gif: a first frame overhanging the screen grows the reported size; later frames count against the cap", () => {
    expect(processImage(gifFrames(1, 1, [{ w: 300, h: 200 }]))).toMatchObject({ width: 300, height: 200 });
    expect(processImage(gifFrames(1, 1, [{ w: 1, h: 1 }, { w: 7000, h: 7000 }, { w: 7000, h: 7000, x: 7000 }]))).toBeNull();
  });
});

describe("animation frame cap", () => {
  test("gif", () => {
    const frames = (n: number) => Array.from({ length: n }, () => ({ w: 1, h: 1 }));
    expect(processImage(gifFrames(1, 1, frames(MAX_FRAMES)))).not.toBeNull();
    expect(processImage(gifFrames(1, 1, frames(MAX_FRAMES + 1)))).toBeNull();
  });

  test("apng, by acTL and by fcTL count", () => {
    const fctls = (n: number) => Array.from({ length: n }, (_, k) => fctl(k, 1, 1));
    expect(processImage(pngFile(ihdr(1, 1), actl(MAX_FRAMES), ...fctls(MAX_FRAMES), idat, iend))).not.toBeNull();
    expect(processImage(pngFile(ihdr(1, 1), actl(100_000), fctl(0, 1, 1), idat, iend))).toBeNull();
    expect(processImage(pngFile(ihdr(1, 1), actl(1), ...fctls(MAX_FRAMES + 1), idat, iend))).toBeNull();
  });

  test("animated webp", () => {
    const frames = (n: number) => Array.from({ length: n }, () => anmf(2, 2, vp8l(2, 2)));
    expect(processImage(webpFile(vp8x(2, 2, 0x02), ...frames(MAX_FRAMES)))).not.toBeNull();
    expect(processImage(webpFile(vp8x(2, 2, 0x02), ...frames(MAX_FRAMES + 1)))).toBeNull();
  });
});

describe("metadata is stripped by allowlist", () => {
  test("png drops C2PA, private and unknown chunks and keeps the rendering ones", () => {
    const keep = ["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs"].map((t) => pngChunk(t, [0, 0, 0, 1]));
    const drop = ["caBX", "prVt", "eXIf", "tEXt", "zTXt", "iTXt", "tIME", "sPLT", "hIST"].map((t) => pngChunk(t, enc(SECRET)));
    const out = processImage(pngFile(ihdr(2, 2), ...keep, ...drop, idat, iend))!;
    expect(contains(out.bytes, SECRET)).toBe(false);
    for (const t of ["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "IDAT", "IEND"]) expect(contains(out.bytes, t)).toBe(true);
    for (const t of ["caBX", "prVt", "sPLT"]) expect(contains(out.bytes, t)).toBe(false);
  });

  test("jpeg keeps a bare JFIF header, the Adobe transform and the ICC profile, and nothing else", () => {
    const jfifThumb = jpegSeg(0xe0, [...enc("JFIF\0"), 1, 2, 0, 0, 1, 0, 1, 2, 1, ...enc(SECRET)]);
    const jfxx = jpegSeg(0xe0, enc(`JFXX\0\x10${SECRET}`));
    const adobe = jpegSeg(0xee, [...enc("Adobe"), 0, 100, 0, 0, 0, 0, 2, ...enc(SECRET)]);
    const notAdobe = jpegSeg(0xee, enc(`Other${SECRET}`));
    const jpgN = [0xf0, 0xf7, 0xfd].map((m) => jpegSeg(m, enc(SECRET)));
    const reserved = jpegSeg(0x02, enc(SECRET));
    const icc = jpegSeg(0xe2, enc("ICC_PROFILE\0\x01\x01icc"));
    const out = processImage(jpegFile(jfifThumb, jfxx, adobe, notAdobe, ...jpgN, reserved, icc, sof0(4, 4)))!;
    expect(out).not.toBeNull();
    expect(contains(out.bytes, SECRET)).toBe(false);
    expect(contains(out.bytes, "JFXX")).toBe(false);
    expect(contains(out.bytes, "ICC_PROFILE")).toBe(true);
    const b = Buffer.from(out.bytes);
    const jfif = b.indexOf("JFIF");
    expect(b.readUInt16BE(jfif - 2)).toBe(16);
    expect([b[jfif + 12], b[jfif + 13]]).toEqual([0, 0]);
    const ad = b.indexOf("Adobe");
    expect(b.readUInt16BE(ad - 2)).toBe(14);
    expect(b[ad + 11]).toBe(2);
    const again = processImage(out.bytes)!;
    expect(Buffer.from(again.bytes).equals(b)).toBe(true);
  });
});
