import { describe, expect, test } from "bun:test";
import { HTML, SECRET, SVG, contains, gif, jpeg, png, webp } from "./__fixtures__/images.ts";
import { MAX_PIXELS, processImage, sniffImageType } from "./image.ts";

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
