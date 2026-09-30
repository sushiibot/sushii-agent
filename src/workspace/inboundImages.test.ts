import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_FETCH_TIMEOUT_MS,
  acceptsImages,
  isAllowedImageUrl,
  loadImageAttachments,
  loadUploadAttachments,
  prepareSteerImages,
  sniffImageType,
  uploadFileName,
} from "./inboundImages.ts";
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

describe("owner uploads", () => {
  const ID = "AAAAAAAAAAAAAAAAAAAAAA";
  const up = (contentType = "image/png") => ({ name: "p.png", contentType, url: `upload:${ID}` });

  test("the file extension comes from the declared type; anything unknown is .bin", () => {
    expect(uploadFileName(ID, "image/png")).toBe(`${ID}.png`);
    expect(uploadFileName(ID, "image/JPEG; q=1")).toBe(`${ID}.jpg`);
    expect(uploadFileName(ID, "image/svg+xml")).toBe(`${ID}.bin`);
  });

  test("a symlink left at the target name is replaced, not written through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-uploads-"));
    try {
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "keep");
      symlinkSync(victim, join(dir, `${ID}.png`));
      const { images, saved } = await loadUploadAttachments(
        [up(), { name: "cdn.png", contentType: "image/png", url: "https://cdn.discordapp.com/a/b/cdn.png" }],
        { principalId: "drk", dir, request: async () => ({ ok: true, name: "p.png", contentType: "image/png", dataBase64: Buffer.from(PNG).toString("base64") }) },
        true,
      );
      expect(images.map((i) => i.mimeType)).toEqual(["image/png"]);
      expect([...saved]).toEqual([ID]);
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(lstatSync(join(dir, `${ID}.png`)).isSymbolicLink()).toBe(false);
      expect(readdirSync(dir).sort()).toEqual([`${ID}.png`, "victim.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an uploads dir that is a symlink, live or dangling, is refused: nothing is written and nothing counts as saved", async () => {
    const home = mkdtempSync(join(tmpdir(), "ws-uploads-home-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "ws-uploads-elsewhere-"));
    try {
      const dir = join(home, "uploads");
      const request = async () => ({ ok: true, name: "p.png", contentType: "image/png", dataBase64: Buffer.from(PNG).toString("base64") });
      for (const target of [elsewhere, join(elsewhere, "missing")]) {
        rmSync(dir, { force: true });
        symlinkSync(target, dir);
        const { images, saved } = await loadUploadAttachments([up()], { principalId: "drk", dir, request }, true);
        expect(images).toEqual([]);
        expect(saved.size).toBe(0);
        expect(readdirSync(elsewhere)).toEqual([]);
      }
      rmSync(dir, { force: true });
      const { saved } = await loadUploadAttachments([up()], { principalId: "drk", dir, request }, true);
      expect([...saved]).toEqual([ID]);
      expect(lstatSync(dir).isDirectory()).toBe(true);
      expect(readdirSync(dir)).toEqual([`${ID}.png`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  describe("when the bot is busy", () => {
    const png = { ok: true, name: "p.png", contentType: "image/png", dataBase64: Buffer.from(PNG).toString("base64") };
    const ids = ["AAAAAAAAAAAAAAAAAAAAA1", "AAAAAAAAAAAAAAAAAAAAA2", "AAAAAAAAAAAAAAAAAAAAA3"];

    async function withDir(fn: (dir: string) => Promise<void>) {
      const dir = mkdtempSync(join(tmpdir(), "ws-uploads-"));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test("uploads are read one at a time, and a busy answer is retried until the bytes come", async () => {
      await withDir(async (dir) => {
        let inFlight = 0;
        let maxInFlight = 0;
        const tries = new Map<string, number>();
        const waits: number[] = [];
        const request = async (_m: string, p: unknown) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
          const id = (p as { uploadId: string }).uploadId;
          tries.set(id, (tries.get(id) ?? 0) + 1);
          return tries.get(id) === 1 ? { ok: false, error: "busy" } : png;
        };
        const atts = ids.map((id) => ({ name: "p.png", contentType: "image/png", url: `upload:${id}` }));
        const { images, saved } = await loadUploadAttachments(atts, { principalId: "drk", dir, request, sleep: async (ms) => void waits.push(ms) }, true);
        expect([...saved]).toEqual(ids);
        expect(images).toHaveLength(3);
        expect(maxInFlight).toBe(1);
        expect(waits).toEqual([250, 250, 250]);
        expect(readdirSync(dir).sort()).toEqual(ids.map((id) => `${id}.png`));
      });
    });

    test("a bot that stays busy is given up on within the backoff bound", async () => {
      await withDir(async (dir) => {
        let calls = 0;
        const waits: number[] = [];
        const request = async () => {
          calls++;
          return { ok: false, error: "busy" };
        };
        const { images, saved } = await loadUploadAttachments([up()], { principalId: "drk", dir, request, sleep: async (ms) => void waits.push(ms) }, true);
        expect(saved.size).toBe(0);
        expect(images).toEqual([]);
        expect(waits).toEqual([250, 500, 1000, 2000]);
        expect(calls).toBe(5);
      });
    });

    test("no retry is waited for that would end past the message's time budget", async () => {
      await withDir(async (dir) => {
        const waits: number[] = [];
        const request = async () => ({ ok: false, error: "busy" });
        const { saved } = await loadUploadAttachments([up()], { principalId: "drk", dir, request, timeoutMs: 600, sleep: async (ms) => void waits.push(ms) }, true);
        expect(saved.size).toBe(0);
        expect(waits).toEqual([250, 500]);
      });
    });

    test("any other refusal is final", async () => {
      await withDir(async (dir) => {
        let calls = 0;
        const request = async () => {
          calls++;
          return { ok: false, error: "not referenced" };
        };
        const { saved } = await loadUploadAttachments([up()], { principalId: "drk", dir, request, sleep: async () => {} }, true);
        expect(saved.size).toBe(0);
        expect(calls).toBe(1);
      });
    });
  });
});
