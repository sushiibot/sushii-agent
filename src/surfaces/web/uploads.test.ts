import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/index.ts";
import { HTML, SECRET, SVG, contains, jpeg, png } from "./__fixtures__/images.ts";
import { DiskUploadStore, UploadError, sanitizeName, type DiskUploadStoreOptions, type StoredUpload } from "./uploads.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 30, 12);
const GiB = 1024 ** 3;

let root: string;
let db: Database;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-uploads-"));
  db = new Database(":memory:");
  applySchema(db);
  clock = T0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function store(opts: Partial<DiskUploadStoreOptions> = {}): DiskUploadStore {
  return new DiskUploadStore({ root, db, now: () => clock, freeBytes: async () => 100 * GiB, ...opts });
}

async function rejects(p: Promise<unknown>): Promise<UploadError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof UploadError) return err;
    throw err;
  }
  throw new Error("expected an UploadError");
}

function row(id: string) {
  return db.query("select * from web_uploads where id = ?").get(id) as Record<string, unknown>;
}

describe("put (owner photos)", () => {
  test("stores a stripped image under yyyy/mm/<id>.<ext> with a sniffed type", async () => {
    const s = store();
    const ref = await s.put({ bytes: jpeg(800, 600, { meta: true }), name: "IMG_1.jpg", direction: "in" });
    expect(ref.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ref).toMatchObject({ contentType: "image/jpeg", inline: true, name: "IMG_1.jpg", width: 800, height: 600 });
    expect(row(ref.id).path).toBe(`2026/09/${ref.id}.jpg`);
    const got = await s.get(ref.id);
    const bytes = new Uint8Array(await (got!.body as Blob).arrayBuffer());
    expect(bytes.byteLength).toBe(ref.bytes);
    expect(contains(bytes, SECRET)).toBe(false);
    expect(readdirSync(join(root, ".tmp"))).toEqual([]);
  });

  test.each([
    ["svg", SVG],
    ["html", HTML],
  ])("rejects %s bytes whatever the declared name", async (_, bytes) => {
    const err = await rejects(store().put({ bytes, name: "cat.png", direction: "in" }));
    expect([err.status, err.code]).toEqual([415, "unsupported_type"]);
    expect(db.query("select count(*) n from web_uploads").get()).toEqual({ n: 0 });
  });

  test("rejects an image it can't measure or that is over the pixel cap", async () => {
    expect((await rejects(store().put({ bytes: jpeg(10, 10, { sof: false }), name: "a", direction: "in" }))).status).toBe(422);
    expect((await rejects(store().put({ bytes: png(10_000, 10_000), name: "a", direction: "in" }))).status).toBe(422);
  });

  test("the same client key and bytes return the same id; different bytes are a conflict", async () => {
    const s = store();
    const a = await s.put({ bytes: png(2, 2), name: "a.png", direction: "in", clientKey: "K1-0" });
    const b = await s.put({ bytes: png(2, 2), name: "a.png", direction: "in", clientKey: "K1-0" });
    expect(b.id).toBe(a.id);
    expect((await rejects(s.put({ bytes: png(3, 3), name: "b.png", direction: "in", clientKey: "K1-0" }))).status).toBe(409);
    const c = await s.put({ bytes: png(3, 3), name: "b.png", direction: "in", clientKey: "K1-1" });
    expect(c.id).not.toBe(a.id);
  });

  test("concurrent puts with one client key store one file", async () => {
    const s = store();
    const refs = await Promise.all([1, 2, 3].map(() => s.put({ bytes: png(2, 2), name: "a", direction: "in", clientKey: "RACE" })));
    expect(new Set(refs.map((r) => r.id)).size).toBe(1);
    expect(db.query("select count(*) n from web_uploads").get()).toEqual({ n: 1 });
    const files = readdirSync(join(root, "2026/09"));
    expect(files).toEqual([`${refs[0]!.id}.png`]);
  });

  test("the photo cap answers 507 and warns once at 80%", async () => {
    const size = png(2, 2).byteLength;
    const warnings: number[] = [];
    const s = store({ limits: { photoCapBytes: size * 5 }, onPhotoQuotaWarning: (used) => warnings.push(used) });
    for (let i = 0; i < 5; i++) await s.put({ bytes: png(2, 2), name: "a", direction: "in" });
    expect(warnings).toEqual([size * 4]);
    const err = await rejects(s.put({ bytes: png(2, 2), name: "a", direction: "in" }));
    expect([err.status, err.code]).toEqual([507, "quota"]);
  });

  test("the daily photo count answers 429 and resets after a day", async () => {
    const s = store({ limits: { photosPerDay: 2 } });
    await s.put({ bytes: png(2, 2), name: "a", direction: "in" });
    await s.put({ bytes: png(2, 2), name: "a", direction: "in" });
    expect((await rejects(s.put({ bytes: png(2, 2), name: "a", direction: "in" }))).status).toBe(429);
    clock += DAY + 1;
    await s.put({ bytes: png(2, 2), name: "a", direction: "in" });
  });
});

describe("files out", () => {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

  test("an image is inline; anything else is octet-stream, whatever it claims to be", async () => {
    const s = store();
    const { files, dropped } = await s.storeDelivery("ob-1", [
      { name: "chart.png", contentType: "image/png", dataBase64: b64(png(20, 10)) },
      { name: "evil.svg", contentType: "image/svg+xml", dataBase64: b64(SVG) },
      { name: "page.html", contentType: "text/html", dataBase64: b64(HTML) },
    ]);
    expect(dropped).toBe(0);
    expect(files.map((f) => [f.contentType, f.inline, f.name])).toEqual([
      ["image/png", true, "chart.png"],
      ["application/octet-stream", false, "evil.svg"],
      ["application/octet-stream", false, "page.html"],
    ]);
    expect(Object.keys(files[0]!)).toEqual(["id", "contentType", "bytes", "name", "inline"]);
    expect(row(files[1]!.id).path).toBe(`2026/09/${files[1]!.id}.bin`);
    expect(s.forOutbox(["ob-1"]).get("ob-1")!.map((f) => f.id)).toEqual(files.map((f) => f.id));
  });

  test("a resent delivery returns the same refs and never overwrites", async () => {
    const s = store();
    const first = await s.storeDelivery("ob-2", [{ name: "a.txt", contentType: "text/plain", dataBase64: b64(new TextEncoder().encode("one")) }]);
    const again = await s.storeDelivery("ob-2", [{ name: "a.txt", contentType: "text/plain", dataBase64: b64(new TextEncoder().encode("two")) }]);
    expect(again.files.map((f) => f.id)).toEqual(first.files.map((f) => f.id));
    const got = await s.get(first.files[0]!.id);
    expect(await (got!.body as Blob).text()).toBe("one");
  });

  test("files over the agent daily quota are dropped, not thrown", async () => {
    const s = store({ limits: { agentBytesPerDay: 10 } });
    const text = (t: string) => ({ name: "f", contentType: "text/plain", dataBase64: b64(new TextEncoder().encode(t)) });
    const out = await s.storeDelivery("ob-3", [text("12345678"), text("12345678")]);
    expect(out.files.length).toBe(1);
    expect(out.dropped).toBe(1);
  });

  test("files over the agent total are dropped too", async () => {
    const s = store({ limits: { agentCapBytes: 10 } });
    const text = (t: string) => ({ name: "f", contentType: "text/plain", dataBase64: b64(new TextEncoder().encode(t)) });
    await s.storeDelivery("ob-4", [text("12345678")]);
    clock += 2 * DAY;
    expect((await s.storeDelivery("ob-5", [text("12345678")])).dropped).toBe(1);
  });

  test("low disk evicts agent files oldest first and never owner photos", async () => {
    let free = 100 * GiB;
    const s = store({ freeBytes: async () => free, limits: { minFreeBytes: 1000, alertFreeBytes: 0 } });
    const photo = await s.put({ bytes: png(2, 2), name: "p", direction: "in" });
    const text = (t: string) => ({ name: "f", contentType: "text/plain", dataBase64: b64(new TextEncoder().encode(t)) });
    const old = await s.storeDelivery("ob-old", [text("old")]);
    clock += 1;
    free = 1000;
    const fresh = await s.storeDelivery("ob-new", [text("new")]);
    expect(fresh.dropped).toBe(1);
    expect(await s.get(old.files[0]!.id)).toBeNull();
    expect(await s.get(photo.id)).not.toBeNull();
    expect((await rejects(s.put({ bytes: png(2, 2), name: "p", direction: "in" }))).code).toBe("disk_full");
  });
});

describe("references, upload/read and GC", () => {
  test("readReferenced serves only referenced owner photos", async () => {
    const s = store();
    const photo = await s.put({ bytes: png(2, 2), name: "p.png", direction: "in" });
    expect(await s.readReferenced(photo.id)).toBeNull();
    s.markReferenced([photo.id, "../../etc/passwd"], "01J00000000000000000000000");
    const got = await s.readReferenced(photo.id);
    expect(got).toMatchObject({ name: "p.png", contentType: "image/png" });
    const out = (await s.storeDelivery("ob", [{ name: "x", contentType: "image/png", dataBase64: Buffer.from(png(2, 2)).toString("base64") }])).files[0]!;
    s.markReferenced([out.id], "01J00000000000000000000000");
    expect(await s.readReferenced(out.id)).toBeNull();
  });

  test("gcOrphans removes only unreferenced photos older than a day, and frees their client key", async () => {
    const s = store();
    const orphan = await s.put({ bytes: png(2, 2), name: "a", direction: "in", clientKey: "OLD" });
    const kept = await s.put({ bytes: png(3, 3), name: "b", direction: "in" });
    s.markReferenced([kept.id], "01J00000000000000000000000");
    const agent = (await s.storeDelivery("ob", [{ name: "x", contentType: "text/plain", dataBase64: "eHg=" }])).files[0]!;
    clock += DAY - 1;
    expect(await s.gcOrphans(clock)).toBe(0);
    clock += 2;
    expect(await s.gcOrphans(clock)).toBe(1);
    expect(await s.get(orphan.id)).toBeNull();
    expect(existsSync(join(root, row(orphan.id).path as string))).toBe(false);
    expect(await s.get(kept.id)).not.toBeNull();
    expect(await s.get(agent.id)).not.toBeNull();
    const again = await s.put({ bytes: png(2, 2), name: "a", direction: "in", clientKey: "OLD" });
    expect(again.id).not.toBe(orphan.id);
  });

  test("lookup ignores bad and unknown ids", async () => {
    const s = store();
    const p: StoredUpload = await s.put({ bytes: png(2, 2), name: "a", direction: "in" });
    const m = s.lookup([p.id, "AAAAAAAAAAAAAAAAAAAAAA", "../x", `${p.id}.png`]);
    expect([...m.keys()]).toEqual([p.id]);
  });

  test("get refuses a stored path that escapes the root", async () => {
    const s = store();
    const p = await s.put({ bytes: png(2, 2), name: "a", direction: "in" });
    db.query("update web_uploads set path = '../../etc/hosts' where id = ?").run(p.id);
    expect(await s.get(p.id)).toBeNull();
  });
});

describe("sanitizeName", () => {
  test.each([
    ['a"b\r\nc.png', "a_bc.png"],
    ["../../etc/passwd", "_.._etc_passwd"],
    ["‮gnp.exe", "gnp.exe"],
    ["...hidden", "hidden"],
    ["", "photo.png"],
    ["\u0000", "photo.png"],
  ])("%j → %j", (raw, want) => expect(sanitizeName(raw, "photo.png")).toBe(want));

  test("caps long names at 128 code points, keeping the extension", () => {
    const out = sanitizeName(`${"é".repeat(300)}.png`, "x");
    expect([...out].length).toBe(128);
    expect(out.endsWith(".png")).toBe(true);
  });
});

test("the temp dir lives under the root so the rename never crosses filesystems", async () => {
  await store().put({ bytes: png(2, 2), name: "a", direction: "in" });
  expect(statSync(join(root, ".tmp")).isDirectory()).toBe(true);
});
