import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import { uploadReadResult } from "../../orchestration/contracts.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import { HTML, SVG, gif, jpeg, png, webp } from "./__fixtures__/images.ts";
import { createPeerMatcher } from "./peers.ts";
import { createWebHandler, type WebHandler } from "./server.ts";
import { FILE_CSP, contentDisposition, createUploadReadHandler } from "./uploadRoutes.ts";
import { DiskUploadStore } from "./uploads.ts";

const OWNER = "owner@example.com";
const GW = "172.31.250.1";
const GiB = 1024 ** 3;

let root: string;
let store: DiskUploadStore;
let handler: WebHandler;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-upload-routes-"));
  const db = new Database(":memory:");
  applySchema(db);
  store = new DiskUploadStore({ root: join(root, "uploads"), db, freeBytes: async () => 100 * GiB });
  const config: WebConfig = {
    port: 0,
    bindAddr: "127.0.0.1",
    ownerLogin: OWNER,
    distDir: join(root, "build"),
    devLogin: undefined,
    trustedPeers: [GW],
    push: undefined,
  };
  handler = createWebHandler({ config, peers: createPeerMatcher(config.trustedPeers), uploads: store });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function upload(body: Uint8Array | null, headers: Record<string, string> = {}, login: string | null = OWNER): Request {
  const h = new Headers({ "Content-Type": "image/jpeg", "Sec-Fetch-Site": "same-origin", ...headers });
  if (login) h.set("Tailscale-User-Login", login);
  return new Request("http://agent.example/api/uploads", { method: "POST", body: body as BodyInit | null, headers: h });
}

function fetchFile(path: string, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }, method = "GET"): Request {
  return new Request(`http://agent.example${path}`, { method, headers: { "Tailscale-User-Login": OWNER, ...headers } });
}

describe("POST /api/uploads", () => {
  test.each([
    ["png", png(40, 30), "image/png"],
    ["jpeg", jpeg(40, 30, { meta: true }), "image/jpeg"],
    ["gif", gif(40, 30), "image/gif"],
    ["webp", webp(40, 30), "image/webp"],
  ])("accepts %s and reports the sniffed type and size", async (_, bytes, type) => {
    const res = await handler(upload(bytes, { "Content-Type": "image/png" }), GW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ contentType: type, width: 40, height: 30 });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test.each([
    ["svg declared as png", SVG],
    ["html declared as png", HTML],
  ])("rejects %s with 415", async (_, bytes) => {
    const res = await handler(upload(bytes, { "Content-Type": "image/png" }), GW);
    expect(res.status).toBe(415);
  });

  test("requires an image content type", async () => {
    for (const type of ["text/plain", "application/octet-stream", "multipart/form-data; boundary=x", ""]) {
      expect((await handler(upload(png(1, 1), { "Content-Type": type }), GW)).status).toBe(415);
    }
  });

  test("refuses cross-site writes, strangers and other peers", async () => {
    expect((await handler(upload(png(1, 1), { "Sec-Fetch-Site": "cross-site" }), GW)).status).toBe(403);
    expect((await handler(upload(png(1, 1), { "Sec-Fetch-Site": "same-site" }), GW)).status).toBe(403);
    expect((await handler(upload(png(1, 1), {}, "other@example.com"), GW)).status).toBe(403);
    expect((await handler(upload(png(1, 1)), "172.31.250.3")).status).toBe(403);
  });

  test("caps the body at 10 MiB, by header and while streaming", async () => {
    expect((await handler(upload(png(1, 1), { "Content-Length": String(10 * 1024 * 1024 + 1) }), GW)).status).toBe(413);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(png(1, 1));
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const req = new Request("http://agent.example/api/uploads", {
      method: "POST",
      body: chunked,
      headers: { "Content-Type": "image/png", "Sec-Fetch-Site": "same-origin", "Tailscale-User-Login": OWNER },
    });
    expect((await handler(req, GW)).status).toBe(413);
  });

  test("an empty body is a 400", async () => {
    expect((await handler(upload(new Uint8Array(0)), GW)).status).toBe(400);
  });

  test("X-Client-Id makes a retry idempotent and must be well-formed", async () => {
    const a = (await (await handler(upload(png(2, 2), { "X-Client-Id": "01J9ZZZZZZZZZZZZZZZZZZZZZZ-0" }), GW)).json()) as { id: string };
    const b = (await (await handler(upload(png(2, 2), { "X-Client-Id": "01J9ZZZZZZZZZZZZZZZZZZZZZZ-0" }), GW)).json()) as { id: string };
    expect(b.id).toBe(a.id);
    expect((await handler(upload(png(3, 3), { "X-Client-Id": "01J9ZZZZZZZZZZZZZZZZZZZZZZ-0" }), GW)).status).toBe(409);
    expect((await handler(upload(png(2, 2), { "X-Client-Id": "../x" }), GW)).status).toBe(400);
  });

  test("X-Upload-Name is percent-decoded and sanitized", async () => {
    const res = await handler(upload(png(2, 2), { "X-Upload-Name": encodeURIComponent('Ünïcode "x"\r\n.png') }), GW);
    const { id } = (await res.json()) as { id: string };
    const file = await handler(fetchFile(`/f/${id}`), GW);
    expect(file.headers.get("Content-Disposition")).toBe(`inline; filename="_n_code _x_.png"; filename*=UTF-8''%C3%9Cn%C3%AFcode%20_x_.png`);
  });
});

describe("GET /f/:id", () => {
  async function stored(bytes: Uint8Array): Promise<string> {
    return ((await (await handler(upload(bytes, { "Content-Type": "image/png" }), GW)).json()) as { id: string }).id;
  }

  test("serves a sniffed image inline with the full header set", async () => {
    const id = await stored(png(4, 4));
    const res = await handler(fetchFile(`/f/${id}`), GW);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toStartWith("inline;");
    expect(res.headers.get("Content-Security-Policy")).toBe(FILE_CSP);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("png magic with an html tail is served as image/png, stripped, with nosniff and the sandbox CSP", async () => {
    const id = await stored(png(4, 4, { tail: "<html><script>alert(1)</script>" }));
    const res = await handler(fetchFile(`/f/${id}`), GW);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Security-Policy")).toBe(FILE_CSP);
    expect(await res.text()).not.toContain("<script>");
  });

  test("an agent file that is not a raster downloads as an opaque attachment", async () => {
    const b64 = Buffer.from(SVG).toString("base64");
    const { files } = await store.storeDelivery("ob-1", [{ name: "x.svg", contentType: "image/svg+xml", dataBase64: b64 }]);
    const res = await handler(fetchFile(`/f/${files[0]!.id}`), GW);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="x.svg"; filename*=UTF-8''x.svg`);
    expect(res.headers.get("Content-Security-Policy")).toBe(FILE_CSP);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test.each([
    "/f/..%2f..%2fetc%2fpasswd",
    "/f/%2e%2e",
    "/f/../../etc/passwd",
    "/f/AAAAAAAAAAAAAAAAAAAAA",
    "/f/AAAAAAAAAAAAAAAAAAAAAAA",
    "/f/AAAAAAAAAAAAAAAAAAAA%2F",
    "/f/AAAAAAAAAAAAAAAAAAAAAA",
    "/f/",
    "/f",
  ])("%s is a no-store 404", async (path) => {
    const res = await handler(fetchFile(path), GW);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("<id>.<ext> and trailing segments don't resolve", async () => {
    const id = await stored(png(2, 2));
    for (const path of [`/f/${id}.png`, `/f/${id}/`, `/f/${id}/x`, `/f/${id}%00`]) {
      expect((await handler(fetchFile(path), GW)).status).toBe(404);
    }
  });

  test("Fetch Metadata: same-origin or absent only", async () => {
    const id = await stored(png(2, 2));
    expect((await handler(fetchFile(`/f/${id}`, {}), GW)).status).toBe(200);
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await handler(fetchFile(`/f/${id}`, { "Sec-Fetch-Site": site }), GW);
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("needs the owner login and a trusted peer", async () => {
    const id = await stored(png(2, 2));
    expect((await handler(new Request(`http://agent.example/f/${id}`), GW)).status).toBe(403);
    expect((await handler(fetchFile(`/f/${id}`), "10.0.0.9")).status).toBe(403);
  });

  test("only GET and HEAD", async () => {
    const id = await stored(png(2, 2));
    const head = await handler(fetchFile(`/f/${id}`, { "Sec-Fetch-Site": "same-origin" }, "HEAD"), GW);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const del = await handler(fetchFile(`/f/${id}`, { "Sec-Fetch-Site": "same-origin" }, "DELETE"), GW);
    expect(del.status).toBe(405);
  });

  test("with no upload store the routes are 404", async () => {
    const bare = createWebHandler({
      config: { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: root, devLogin: undefined, trustedPeers: [GW], push: undefined },
      peers: createPeerMatcher([GW]),
    });
    expect((await bare(upload(png(1, 1)), GW)).status).toBe(404);
    expect((await bare(fetchFile("/f/AAAAAAAAAAAAAAAAAAAAAA"), GW)).status).toBe(404);
  });
});

describe("contentDisposition", () => {
  test.each([
    ["plain.pdf", `attachment; filename="plain.pdf"; filename*=UTF-8''plain.pdf`],
    [`a"b\r\nc`, `attachment; filename="abc"; filename*=UTF-8''abc`],
    ["it's (1)*!.txt", `attachment; filename="it's (1)*!.txt"; filename*=UTF-8''it%27s%20%281%29%2A%21.txt`],
    ["100%;x\\y.txt", `attachment; filename="100__x_y.txt"; filename*=UTF-8''100%25%3Bx%5Cy.txt`],
    ["日本.png", `attachment; filename="__.png"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.png`],
  ])("%j", (name, want) => expect(contentDisposition("attachment", name)).toBe(want));
});

describe("upload/read handler", () => {
  const P = "drk";
  const CONN: ConnectionInfo = { runnerId: "workspace-drk", role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };

  test("returns a referenced photo's bytes and refuses everything else", async () => {
    const read = createUploadReadHandler(store, P);
    const photo = await store.put({ bytes: png(5, 5), name: "p.png", direction: "in" });
    expect(await read(CONN, { principalId: P, uploadId: photo.id })).toEqual({ ok: false, error: "not found" });
    store.markReferenced([photo.id], "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
    const ok = await read(CONN, { principalId: P, uploadId: photo.id });
    expect(uploadReadResult.safeParse(ok).success).toBe(true);
    expect(ok).toMatchObject({ ok: true, name: "p.png", contentType: "image/png" });
    if (ok.ok) expect(Buffer.from(ok.dataBase64, "base64").byteLength).toBe(photo.bytes);

    expect(await read(CONN, { principalId: "other", uploadId: photo.id })).toEqual({ ok: false, error: "principal mismatch" });
    expect(await read({ ...CONN, principalId: "other" }, { principalId: P, uploadId: photo.id })).toEqual({ ok: false, error: "principal mismatch" });
    expect(await read(CONN, { principalId: P, uploadId: "../../../../etc/passwd" })).toEqual({ ok: false, error: "invalid params" });
    expect(await read(CONN, { principalId: P, uploadId: `${photo.id.slice(0, 21)}.` })).toEqual({ ok: false, error: "invalid params" });
  });

  describe("concurrency", () => {
    const ID = "A".repeat(22);
    const ID2 = "B".repeat(22);
    function gated(sizes: Record<string, number> = {}) {
      const waiting: { resolve: () => void; reject: (e: Error) => void }[] = [];
      const fake = {
        referencedSize: (id: string) => sizes[id] ?? 10,
        readReferenced: (id: string) =>
          new Promise<{ name: string; contentType: string; bytes: Uint8Array }>((resolve, reject) =>
            waiting.push({ resolve: () => resolve({ name: id, contentType: "image/png", bytes: new Uint8Array(sizes[id] ?? 10) }), reject }),
          ),
      };
      return { fake, waiting };
    }
    const req = (uploadId = ID) => ({ principalId: P, uploadId });

    test("a third concurrent read is busy, and a slot frees once a read finishes or throws", async () => {
      const { fake, waiting } = gated();
      const read = createUploadReadHandler(fake, P);
      const a = read(CONN, req());
      const b = read(CONN, req());
      expect(await read(CONN, req())).toEqual({ ok: false, error: "busy" });
      waiting[0]!.resolve();
      expect(await a).toMatchObject({ ok: true });
      const c = read(CONN, req());
      expect(await read(CONN, req())).toEqual({ ok: false, error: "busy" });
      waiting[1]!.reject(new Error("disk"));
      await expect(b).rejects.toThrow("disk");
      const d = read(CONN, req());
      waiting[2]!.resolve();
      waiting[3]!.resolve();
      expect(await c).toMatchObject({ ok: true });
      expect(await d).toMatchObject({ ok: true });
    });

    test("the byte budget refuses a read on its own, before the file is loaded", async () => {
      const { fake, waiting } = gated({ [ID]: 6, [ID2]: 5 });
      const read = createUploadReadHandler(fake, P, { maxInFlight: 5, maxInFlightBytes: 10 });
      const a = read(CONN, req(ID));
      expect(await read(CONN, req(ID2))).toEqual({ ok: false, error: "busy" });
      expect(waiting.length).toBe(1);
      waiting[0]!.resolve();
      await a;
      const b = read(CONN, req(ID2));
      waiting[1]!.resolve();
      expect(await b).toMatchObject({ ok: true, name: ID2 });
    });

    test("an unknown id is not found without taking a slot", async () => {
      const read = createUploadReadHandler({ referencedSize: () => null, readReferenced: async () => null }, P, { maxInFlight: 0, maxInFlightBytes: 0 });
      expect(await read(CONN, req())).toEqual({ ok: false, error: "not found" });
    });
  });
});
