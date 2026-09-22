import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import { materializeMessageAttachments, runSpawn } from "./attachments.ts";

// A minimal, valid, blank-page PDF: enough for pdftotext to extract zero text and pdftoppm to
// rasterize one page, without pulling in a fixture asset.
const BLANK_PDF = Buffer.from(
  "%PDF-1.1\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Size 4/Root 1 0 R>>\n" +
    "%%EOF\n",
  "utf8",
);

// A minimal, valid, one-page PDF with an actual extractable text stream.
const PDF_WITH_TEXT = Buffer.from(
  "%PDF-1.1\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "5 0 obj<</Length 88>>\n" +
    "stream\n" +
    "BT /F1 12 Tf 20 100 Td (hello materialize pipeline twice for length verification) Tj ET\n" +
    "endstream\n" +
    "endobj\n" +
    "trailer<</Size 6/Root 1 0 R>>\n" +
    "%%EOF\n",
  "utf8",
);

const PDFTOTEXT_AVAILABLE = Bun.which("pdftotext") !== null;
const PDFTOPPM_AVAILABLE = Bun.which("pdftoppm") !== null;
const itIfPoppler = test.skipIf(!PDFTOTEXT_AVAILABLE || !PDFTOPPM_AVAILABLE);
if (!PDFTOTEXT_AVAILABLE || !PDFTOPPM_AVAILABLE) {
  console.warn("pdftotext/pdftoppm not found on PATH -- skipping PDF materialize tests. See Dockerfile for install.");
}

function msg(overrides: Partial<WikiSyncMessage> = {}): WikiSyncMessage {
  return {
    surface: "discord",
    spaceId: "g1",
    messageId: "555",
    channelId: "chan1",
    parentChannelId: null,
    authorId: "u1",
    authorUsername: "someuser",
    authorDisplayName: null,
    content: "hello",
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    replyTo: null,
    ...overrides,
  };
}

import type { AttachmentSource, FetchedAttachment, Replacement } from "./context.ts";

// The Discord-shaped reference rewrite (attachment id captured from the CDN URL). The neutral
// materialize pipeline under test calls this back to relocate labels to local paths; the real
// impl lives in the Discord surface.
const CDN_LABEL_URL_RE = /\]\((https:\/\/cdn\.discordapp\.com\/attachments\/\d+\/(\d+)\/[^\s)]+)\)/g;
function rewriteAttachmentLinks(content: string, replacements: Map<string, Replacement>): string {
  return content.replace(CDN_LABEL_URL_RE, (full, _url, id) => {
    const r = replacements.get(id);
    return r ? `](${r.url})${r.extra ?? ""}` : full;
  });
}

/** An AttachmentSource returning a fixed list — the Discord impl (CDN detect + channel/message
 *  fetch → map) lives in the surface now; the engine only sees this interface. */
function source(attachments: FetchedAttachment[]): AttachmentSource {
  return { attachmentsFor: async () => attachments, rewriteAttachmentLinks };
}

/** Models a source that can't be fetched (attachmentsFor throws → content unchanged). */
const throwingSource: AttachmentSource = {
  attachmentsFor: async () => {
    throw new Error("unknown channel");
  },
  rewriteAttachmentLinks,
};

let dir: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wiki-sync-attachments-test-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("materializeMessageAttachments", () => {
  test("returns content unchanged when it has no Discord CDN attachment urls", async () => {
    const src = source([]);
    const content = await materializeMessageAttachments(src, dir, msg({ content: "just text, no urls" }));
    expect(content).toBe("just text, no urls");
  });

  test("returns content unchanged when the channel can't be refetched", async () => {
    const src = throwingSource;
    const original =
      "[image: foo.png](https://cdn.discordapp.com/attachments/9999999999/1111/foo.png?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));
    expect(content).toBe(original);
  });

  test("returns content unchanged when the channel isn't text-based", async () => {
    const src = source([]);
    const original =
      "[image: foo.png](https://cdn.discordapp.com/attachments/9999999999/1111/foo.png?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));
    expect(content).toBe(original);
  });

  test("downloads an image attachment and rewrites its label to the absolute local path", async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3, 4]))) as unknown as typeof fetch;
    const src = source([
        { id: "1111", name: "foo.png", url: "https://cdn.discordapp.com/attachments/9999999999/1111/foo.png?ex=abc", contentType: "image/png", size: 4 },
      ]);
    const original = "[image: foo.png](https://cdn.discordapp.com/attachments/9999999999/1111/foo.png?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    const match = content.match(/\[image: foo\.png\]\((.+)\)/);
    expect(match).not.toBeNull();
    const localPath = match![1]!;
    expect(localPath.startsWith("/")).toBe(true);
    expect(existsSync(localPath)).toBe(true);
    expect(await readFile(localPath)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("downloads a text attachment and rewrites its label", async () => {
    globalThis.fetch = (async () => new Response("hello from a text file")) as unknown as typeof fetch;
    const src = source([
        { id: "2222", name: "notes.txt", url: "https://cdn.discordapp.com/attachments/9999999999/2222/notes.txt?ex=abc", contentType: "text/plain", size: 20 },
      ]);
    const original = "[text: notes.txt](https://cdn.discordapp.com/attachments/9999999999/2222/notes.txt?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    const match = content.match(/\[text: notes\.txt\]\((.+)\)/);
    const localPath = match![1]!;
    expect(await readFile(localPath, "utf8")).toBe("hello from a text file");
  });

  test("leaves an unknown binary attachment's label unchanged and doesn't download it", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(new Uint8Array([0]));
    }) as unknown as typeof fetch;
    const src = source([
        { id: "3333", name: "clip.mp4", url: "https://cdn.discordapp.com/attachments/9999999999/3333/clip.mp4?ex=abc", contentType: "video/mp4", size: 1000 },
      ]);
    const original = "[video: clip.mp4](https://cdn.discordapp.com/attachments/9999999999/3333/clip.mp4?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    expect(content).toBe(original);
    expect(fetchCalled).toBe(false);
  });

  test("skips a download that exceeds the max byte cap and leaves the label unchanged", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(new Uint8Array([1]));
    }) as unknown as typeof fetch;
    const src = source([
        {
          id: "4444",
          name: "huge.png",
          url: "https://cdn.discordapp.com/attachments/9999999999/4444/huge.png?ex=abc",
          contentType: "image/png",
          size: 100 * 1024 * 1024,
        },
      ]);
    const original = "[image: huge.png](https://cdn.discordapp.com/attachments/9999999999/4444/huge.png?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    expect(content).toBe(original);
    expect(fetchCalled).toBe(false);
  });

  itIfPoppler("extracts PDF text and points the label at the .txt file", async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array(PDF_WITH_TEXT))) as unknown as typeof fetch;
    const src = source([
        { id: "6666", name: "doc.pdf", url: "https://cdn.discordapp.com/attachments/9999999999/6666/doc.pdf?ex=abc", contentType: "application/pdf", size: PDF_WITH_TEXT.length },
      ]);
    const original = "[application: doc.pdf](https://cdn.discordapp.com/attachments/9999999999/6666/doc.pdf?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    const match = content.match(/\[application: doc\.pdf\]\((.+?)\)/);
    expect(match).not.toBeNull();
    const localPath = match![1]!;
    expect(localPath.endsWith(".txt")).toBe(true);
    expect(localPath.startsWith("/")).toBe(true);
    expect(await readFile(localPath, "utf8")).toContain("hello materialize pipeline twice for length verification");
  });

  // A blank page has no extractable text, so pdftotext falls through to pdftoppm rasterization.
  itIfPoppler("rasterizes a text-free PDF into page images", async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array(BLANK_PDF))) as unknown as typeof fetch;
    const src = source([
        { id: "5555", name: "doc.pdf", url: "https://cdn.discordapp.com/attachments/9999999999/5555/doc.pdf?ex=abc", contentType: "application/pdf", size: BLANK_PDF.length },
      ]);
    const original = "[application: doc.pdf](https://cdn.discordapp.com/attachments/9999999999/5555/doc.pdf?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    const match = content.match(/\[application: doc\.pdf\]\((.+?)\)/);
    expect(match).not.toBeNull();
    const pagePath = match![1]!;
    expect(pagePath.startsWith("/")).toBe(true);
    expect(pagePath.endsWith(".png")).toBe(true);
    expect(existsSync(pagePath)).toBe(true);
  });

  test("materializes an image with a null contentType via its file extension", async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array([9, 9, 9]))) as unknown as typeof fetch;
    const src = source([
        { id: "7777", name: "screenshot.png", url: "https://cdn.discordapp.com/attachments/9999999999/7777/screenshot.png?ex=abc", contentType: null, size: 3 },
      ]);
    const original = "[attachment: screenshot.png](https://cdn.discordapp.com/attachments/9999999999/7777/screenshot.png?ex=abc)";
    const content = await materializeMessageAttachments(src, dir, msg({ content: original }));

    const match = content.match(/\[attachment: screenshot\.png\]\((.+)\)/);
    expect(match).not.toBeNull();
    const localPath = match![1]!;
    expect(existsSync(localPath)).toBe(true);
    expect(await readFile(localPath)).toEqual(Buffer.from([9, 9, 9]));
  });

  // A missing poppler binary (pdfinfo/pdftotext/pdftoppm) must degrade, not crash the sweep:
  // runSpawn resolves to { ok: false } rather than throwing on ENOENT, which is what lets
  // materializePdf fall back (skip clamp, or leave the label). Tested directly against runSpawn
  // because it is portable and needs no real poppler -- a fake-PATH approach does NOT work here,
  // since Bun.spawn resolves the command against the real process PATH, not a mutated Bun.env.PATH.
  test("runSpawn degrades to ok:false when the binary is missing, without throwing", async () => {
    const result = await runSpawn(["sushii-nonexistent-binary-zzz", "--version"], 2000);
    expect(result.ok).toBe(false);
  });

  // Regression: the timeout must SIGKILL, not SIGTERM. A single process that traps SIGTERM (like a
  // poppler binary slow to handle it) would ignore a default kill() and run indefinitely, leaving
  // `await proc.exited` pending and hanging a pool worker for the whole sweep. A busy-loop keeps
  // this to one process (no grandchild inheriting the stdout pipe) so it models the real commands,
  // which never fork; runSpawn must reap it and return ok:false well within the loop's lifetime.
  test("runSpawn kills a SIGTERM-ignoring subprocess by its timeout instead of hanging", async () => {
    const start = Date.now();
    const result = await runSpawn(["sh", "-c", "trap '' TERM; while :; do :; done"], 200);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    // Runs forever without SIGKILL; ~200ms with it. A generous bound avoids CI flakiness.
    expect(elapsed).toBeLessThan(2000);
  });
});
