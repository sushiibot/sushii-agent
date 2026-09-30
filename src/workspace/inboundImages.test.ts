import { describe, expect, test } from "bun:test";
import { acceptsImages, loadImageAttachments, sniffImageType } from "./inboundImages.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
const att = (name: string, contentType = "image/png") => ({ name, contentType, url: `https://cdn/${name}` });

describe("loadImageAttachments", () => {
  test("image attachments become image content typed by their bytes; other files are skipped", async () => {
    const fetched: string[] = [];
    const images = await loadImageAttachments([att("a.png"), att("b.jpg", "image/png"), att("c.txt", "text/plain")], {
      fetch: async (url) => {
        fetched.push(url);
        return new Response(url.endsWith("a.png") ? PNG : JPEG);
      },
    });
    expect(fetched).toEqual(["https://cdn/a.png", "https://cdn/b.jpg"]);
    expect(images.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(images[0]!.data).toBe(Buffer.from(PNG).toString("base64"));
  });

  test("failures, HTTP errors, oversize bodies and non-image bytes are left out without throwing", async () => {
    const images = await loadImageAttachments([att("err.png"), att("404.png"), att("big.png"), att("fake.png")], {
      maxBytes: 16,
      fetch: async (url) => {
        if (url.endsWith("err.png")) throw new Error("network");
        if (url.endsWith("404.png")) return new Response("nope", { status: 404 });
        if (url.endsWith("big.png")) return new Response(new Uint8Array(64));
        return new Response("<html>");
      },
    });
    expect(images).toEqual([]);
  });
});

describe("helpers", () => {
  test("sniffing knows the four provider-safe formats", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("<svg/>"))).toBeNull();
  });

  test("a model is image-capable unless it declares text-only input", () => {
    expect(acceptsImages({ model: { input: ["text", "image"] } })).toBe(true);
    expect(acceptsImages({ model: { input: ["text"] } })).toBe(false);
    expect(acceptsImages({})).toBe(true);
  });
});
