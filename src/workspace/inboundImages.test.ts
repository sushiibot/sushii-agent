import { describe, expect, test } from "bun:test";
import { IMAGE_FETCH_TIMEOUT_MS, acceptsImages, isAllowedImageUrl, loadImageAttachments, prepareSteerImages, sniffImageType } from "./inboundImages.ts";
import { MESSAGE_TIMEOUT_MS } from "../orchestration/workspace/link.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
const att = (name: string, contentType = "image/png") => ({ name, contentType, url: `https://cdn.discordapp.com/attachments/1/2/${name}` });

describe("loadImageAttachments", () => {
  test("image attachments become image content typed by their bytes; other files are skipped", async () => {
    const fetched: string[] = [];
    const images = await loadImageAttachments([att("a.png"), att("b.jpg", "image/png"), att("c.txt", "text/plain")], {
      fetch: async (url) => {
        fetched.push(url);
        return new Response(url.endsWith("a.png") ? PNG : JPEG);
      },
    });
    expect(fetched).toEqual([att("a.png").url, att("b.jpg").url]);
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

describe("image URLs", () => {
  test("only https URLs on Discord's CDN are fetched, and never with redirects", async () => {
    const inits: RequestInit[] = [];
    const fetched: string[] = [];
    const urls = [
      "https://media.discordapp.net/attachments/1/2/a.png",
      "http://cdn.discordapp.com/attachments/1/2/a.png",
      "https://evil.example/a.png",
      "https://cdn.discordapp.com.evil.example/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://cdn.discordapp.com:8443/a.png",
      "https://user@cdn.discordapp.com/a.png",
      "not a url",
    ];
    const images = await loadImageAttachments(
      urls.map((url) => ({ name: "a.png", contentType: "image/png", url })),
      {
        fetch: async (url, init) => {
          fetched.push(url);
          inits.push(init);
          return new Response(PNG);
        },
      },
    );
    expect(fetched).toEqual([urls[0]!]);
    expect(images.length).toBe(1);
    expect(inits[0]!.redirect).toBe("error");
    expect(isAllowedImageUrl("https://cdn.discordapp.com/attachments/1/2/a.png")).toBe(true);
  });

  test("the download gives up before the bot stops waiting for the message's ack", () => {
    expect(IMAGE_FETCH_TIMEOUT_MS).toBeLessThan(MESSAGE_TIMEOUT_MS);
  });
});

describe("prepareSteerImages", () => {
  test("Pi's resizer passes a small valid image through with no note", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const out = await prepareSteerImages("hi", [{ type: "image", data: png, mimeType: "image/png" }]);
    expect(out.text).toBe("hi");
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mimeType).toBe("image/png");
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
