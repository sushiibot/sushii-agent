import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { kv, webUploads } from "../../db/schema.ts";
import { ID_MAX, UPLOAD_ID_RE, type DeliverFile } from "../../orchestration/contracts.ts";
import { getLogger } from "../../logger.ts";
import type { UploadRef } from "./events.ts";
import { IMAGE_MIME, processImage, sniffImageType } from "./image.ts";

export type { UploadRef } from "./events.ts";

const log = getLogger("web-uploads");

const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1_000_000_000;
const MB = 1_000_000;
const NAME_MAX = 128;
const TMP_DIR = ".tmp";
const OCTET = "application/octet-stream";
const PHOTO_WARNED_KEY = "web_uploads:photo_quota_warned";
const LOW_DISK_ALERT_EVERY_MS = 60 * 60 * 1000;
const PURGE_DELETED_AFTER_MS = 30 * DAY_MS;
/** Agent files are charged in filesystem blocks, so a flood of empty files still costs disk and quota. */
const BLOCK = 4096;
const charged = (bytes: number) => Math.max(1, Math.ceil(bytes / BLOCK)) * BLOCK;

export interface UploadLimits {
  photoCapBytes: number;
  /** Fraction of photoCapBytes that triggers the one-off quota warning. */
  photoWarnRatio: number;
  photosPerDay: number;
  agentCapBytes: number;
  agentBytesPerDay: number;
  agentFileCap: number;
  agentFilesPerDay: number;
  /** Free disk that must remain after a write; below it agent files are evicted, then the write is refused. */
  minFreeBytes: number;
  /** Free disk under which each write logs an alert. */
  alertFreeBytes: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  photoCapBytes: 5 * GB,
  photoWarnRatio: 0.8,
  photosPerDay: 200,
  agentCapBytes: 1 * GB,
  agentBytesPerDay: 200 * MB,
  agentFileCap: 5000,
  agentFilesPerDay: 500,
  minFreeBytes: 512 * 1024 * 1024,
  alertFreeBytes: 2 * 1024 * 1024 * 1024,
};

/** A put the store refused; `status` is the HTTP status the upload route answers with. */
export class UploadError extends Error {
  constructor(
    readonly status: 400 | 409 | 415 | 422 | 429 | 507,
    readonly code: "bad_request" | "conflict" | "unsupported_type" | "unreadable_image" | "daily_limit" | "quota" | "disk_full",
    message: string,
  ) {
    super(message);
  }
}

export type StoredUpload = UploadRef & { width?: number; height?: number };

/** Every input id lands in exactly one list. `missing` covers malformed, unknown, agent-file and deleted ids. */
export interface MarkReferencedResult {
  referenced: string[];
  missing: string[];
}

export interface PutInput {
  bytes: Uint8Array;
  name: string;
  direction: "in" | "out";
  clientKey?: string;
  outboxId?: string;
}

/** Disk now, object store later. Types are sniffed from the bytes, never taken from the caller. */
export interface UploadStore {
  put(i: PutInput): Promise<StoredUpload>;
  get(id: string): Promise<{ meta: UploadRef; body: ReadableStream | Blob } | null>;
  markReferenced(ids: string[], messageClientId: string): MarkReferencedResult;
  gcOrphans(now: number): Promise<number>;
}

export interface DiskUploadStoreOptions {
  root: string;
  db: Database;
  now?: () => number;
  limits?: Partial<UploadLimits>;
  /** Bytes available to this process on the filesystem holding `root`. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Called once each time owner photos cross the warning ratio. */
  onPhotoQuotaWarning?: (usedBytes: number, capBytes: number) => void;
}

type Row = typeof webUploads.$inferSelect;

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { webUploads, kv } });
}

function newUploadId(): string {
  return randomBytes(16).toString("base64url");
}

const BIDI_AND_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Client or workspace filenames are display metadata only: no controls, bidi overrides, quotes or separators. */
export function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw.normalize("NFC").replace(BIDI_AND_CONTROL, "").replace(/["'\\/]/g, "_").trim().replace(/^\.+/, "");
  const capped = [...cleaned].slice(-NAME_MAX).join("");
  return capped || fallback;
}

function toRef(r: Row): StoredUpload {
  return {
    id: r.id,
    contentType: r.contentType,
    bytes: r.bytes,
    name: r.name,
    inline: r.inline === 1,
    ...(r.width !== null ? { width: r.width } : {}),
    ...(r.height !== null ? { height: r.height } : {}),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export class DiskUploadStore implements UploadStore {
  readonly root: string;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly limits: UploadLimits;
  private readonly freeBytes: (dir: string) => Promise<number>;
  private readonly onPhotoQuotaWarning?: (usedBytes: number, capBytes: number) => void;
  private lastLowDiskAlert = 0;

  constructor(opts: DiskUploadStoreOptions) {
    this.root = resolve(opts.root);
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.limits = { ...DEFAULT_UPLOAD_LIMITS, ...opts.limits };
    this.freeBytes = opts.freeBytes ?? defaultFreeBytes;
    this.onPhotoQuotaWarning = opts.onPhotoQuotaWarning;
  }

  async put(i: PutInput): Promise<StoredUpload> {
    const key = i.clientKey !== undefined ? `${i.direction}:${i.clientKey}` : null;
    if (key !== null && key.length > ID_MAX * 2) throw new UploadError(400, "bad_request", "client key too long");
    if (i.outboxId !== undefined && i.outboxId.length > ID_MAX) throw new UploadError(400, "bad_request", "outbox id too long");
    const sha256 = createHash("sha256").update(i.bytes).digest("hex");
    if (key !== null) {
      const existing = this.byKey(key);
      if (existing) return this.sameOrConflict(existing, sha256);
    }

    let body: Uint8Array;
    let contentType: string;
    let inline: boolean;
    let ext: string;
    let width: number | null = null;
    let height: number | null = null;
    const img = processImage(i.bytes);
    if (img) {
      body = img.bytes;
      contentType = IMAGE_MIME[img.type];
      inline = true;
      ext = img.type === "jpeg" ? "jpg" : img.type;
      width = img.width;
      height = img.height;
    } else if (i.direction === "in") {
      if (sniffImageType(i.bytes)) throw new UploadError(422, "unreadable_image", "the image is malformed or over the pixel cap");
      throw new UploadError(415, "unsupported_type", "only png, jpeg, gif and webp images are accepted");
    } else {
      body = i.bytes;
      contentType = OCTET;
      inline = false;
      ext = "bin";
    }
    const name = sanitizeName(i.name, i.direction === "in" ? `photo.${ext}` : "file");

    const now = this.now();
    this.checkQuota(i.direction, body.byteLength, now);
    await this.ensureDiskSpace(body.byteLength);

    const id = newUploadId();
    const d = new Date(now);
    const rel = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
    const abs = this.absPath(rel)!;
    const tmp = join(this.root, TMP_DIR, id);
    await mkdir(join(this.root, TMP_DIR), { recursive: true });
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(tmp, body);
    await rename(tmp, abs);

    const row: Row = {
      id,
      direction: i.direction,
      contentType,
      inline: inline ? 1 : 0,
      bytes: body.byteLength,
      width,
      height,
      name,
      path: rel,
      sha256,
      clientKey: key,
      outboxId: i.outboxId ?? null,
      messageClientId: null,
      createdAt: now,
      referencedAt: null,
      deletedAt: null,
    };
    try {
      ormFor(this.db).insert(webUploads).values(row).run();
    } catch (err) {
      await unlink(abs).catch(() => {});
      const raced = key !== null && isUniqueViolation(err) ? this.byKey(key) : undefined;
      if (raced) return this.sameOrConflict(raced, sha256);
      throw err;
    }
    if (i.direction === "in") this.checkPhotoWarning();
    return toRef(row);
  }

  async get(id: string): Promise<{ meta: UploadRef; body: ReadableStream | Blob } | null> {
    const row = this.liveRow(id);
    if (!row) return null;
    const abs = this.absPath(row.path);
    if (!abs) return null;
    const file = Bun.file(abs);
    if (!(await file.exists())) return null;
    return { meta: toRef(row), body: file };
  }

  /** An id already referenced by an earlier send counts as referenced, so a retried message is not refused. */
  markReferenced(ids: string[], messageClientId: string): MarkReferencedResult {
    const unique = [...new Set(ids)];
    const valid = unique.filter((id) => UPLOAD_ID_RE.test(id));
    const orm = ormFor(this.db);
    const live = this.db.transaction(() => {
      if (!valid.length) return new Set<string>();
      orm
        .update(webUploads)
        .set({ referencedAt: this.now(), messageClientId })
        .where(and(inArray(webUploads.id, valid), eq(webUploads.direction, "in"), isNull(webUploads.referencedAt), isNull(webUploads.deletedAt)))
        .run();
      const rows = orm
        .select({ id: webUploads.id })
        .from(webUploads)
        .where(and(inArray(webUploads.id, valid), eq(webUploads.direction, "in"), isNotNull(webUploads.referencedAt), isNull(webUploads.deletedAt)))
        .all();
      return new Set(rows.map((r) => r.id));
    })();
    return { referenced: unique.filter((id) => live.has(id)), missing: unique.filter((id) => !live.has(id)) };
  }

  /** Deletes owner photos never attached to a message within a day, stale temp files, and rows deleted
   *  over 30 days ago. */
  async gcOrphans(now: number): Promise<number> {
    const orphans = ormFor(this.db)
      .select()
      .from(webUploads)
      .where(and(eq(webUploads.direction, "in"), isNull(webUploads.referencedAt), isNull(webUploads.deletedAt), lt(webUploads.createdAt, now - DAY_MS)))
      .all();
    let removed = 0;
    for (const row of orphans) if (await this.remove(row, now)) removed++;
    await this.sweepTmp(now);
    const purged = ormFor(this.db)
      .delete(webUploads)
      .where(and(isNotNull(webUploads.deletedAt), lt(webUploads.deletedAt, now - PURGE_DELETED_AFTER_MS)))
      .returning({ id: webUploads.id })
      .all().length;
    if (removed || purged) log.info({ removed, purged }, "cleaned up web uploads");
    return removed;
  }

  /** Known, still-stored uploads among `ids`, for the history rewrite's existence check. */
  lookup(ids: string[]): Map<string, UploadRef> {
    const valid = ids.filter((id) => UPLOAD_ID_RE.test(id));
    const out = new Map<string, UploadRef>();
    if (!valid.length) return out;
    const rows = ormFor(this.db)
      .select()
      .from(webUploads)
      .where(and(inArray(webUploads.id, valid), isNull(webUploads.deletedAt)))
      .all();
    for (const r of rows) out.set(r.id, toRef(r));
    return out;
  }

  /** Agent files stored for each delivery, in send order. */
  forOutbox(outboxIds: string[]): Map<string, UploadRef[]> {
    const out = new Map<string, UploadRef[]>();
    if (!outboxIds.length) return out;
    const rows = ormFor(this.db)
      .select()
      .from(webUploads)
      .where(and(inArray(webUploads.outboxId, outboxIds), eq(webUploads.direction, "out"), isNull(webUploads.deletedAt)))
      .orderBy(asc(webUploads.createdAt), asc(sql`rowid`))
      .all();
    for (const r of rows) {
      const list = out.get(r.outboxId!) ?? [];
      list.push(toRef(r));
      out.set(r.outboxId!, list);
    }
    return out;
  }

  /** Stores a delivery's send_file files, idempotent per (outboxId, index): a resend returns the same refs and
   *  never overwrites. Files over an agent quota or the disk floor are dropped and counted, not thrown. */
  async storeDelivery(outboxId: string, files: DeliverFile[]): Promise<{ files: UploadRef[]; dropped: number }> {
    const refs: UploadRef[] = [];
    let dropped = 0;
    for (const [index, f] of files.entries()) {
      const clientKey = `${outboxId}#${index}`;
      try {
        refs.push(stripDims(await this.put({ bytes: new Uint8Array(Buffer.from(f.dataBase64, "base64")), name: f.name, direction: "out", clientKey, outboxId })));
      } catch (err) {
        if (err instanceof UploadError && (err.code === "quota" || err.code === "disk_full")) {
          log.warn({ outboxId, index, code: err.code }, "agent file dropped");
          dropped++;
        } else if (err instanceof UploadError && err.code === "conflict") {
          log.warn({ outboxId, index }, "resent delivery file differs from the stored one; keeping the stored file");
          const existing = this.byKey(`out:${clientKey}`);
          if (existing) refs.push(stripDims(toRef(existing)));
        } else throw err;
      }
    }
    return { files: refs, dropped };
  }

  /** upload/read: bytes of an owner photo a chat/message referenced, for the workspace. */
  async readReferenced(id: string): Promise<{ name: string; contentType: string; bytes: Uint8Array } | null> {
    const row = this.liveRow(id);
    if (!row || row.direction !== "in" || row.referencedAt === null) return null;
    const abs = this.absPath(row.path);
    if (!abs) return null;
    const file = Bun.file(abs);
    if (!(await file.exists())) return null;
    return { name: row.name, contentType: row.contentType, bytes: new Uint8Array(await file.arrayBuffer()) };
  }

  /** Stored size of a photo readReferenced would serve, read from the row without touching the file. */
  referencedSize(id: string): number | null {
    const row = this.liveRow(id);
    return row && row.direction === "in" && row.referencedAt !== null ? row.bytes : null;
  }

  photoUsage(): { usedBytes: number; capBytes: number } {
    return { usedBytes: this.sumBytes("in"), capBytes: this.limits.photoCapBytes };
  }

  private liveRow(id: string): Row | undefined {
    if (!UPLOAD_ID_RE.test(id)) return undefined;
    return ormFor(this.db)
      .select()
      .from(webUploads)
      .where(and(eq(webUploads.id, id), isNull(webUploads.deletedAt)))
      .get();
  }

  private byKey(key: string): Row | undefined {
    return ormFor(this.db)
      .select()
      .from(webUploads)
      .where(and(eq(webUploads.clientKey, key), isNull(webUploads.deletedAt)))
      .get();
  }

  private sameOrConflict(row: Row, sha256: string): StoredUpload {
    if (row.sha256 === sha256) return toRef(row);
    throw new UploadError(409, "conflict", "this client key was already used for different bytes");
  }

  /** The row's path under root; null if it would escape root. Paths are only ever built by put(). */
  private absPath(rel: string): string | null {
    const abs = resolve(this.root, rel);
    return abs.startsWith(this.root + sep) ? abs : null;
  }

  /** Live rows, or with `since` every row created since then, deleted or not. */
  private usage(direction: "in" | "out", since?: number): { files: number; bytes: number; blocks: number } {
    const where = [eq(webUploads.direction, direction)];
    if (since === undefined) where.push(isNull(webUploads.deletedAt));
    else where.push(gte(webUploads.createdAt, since));
    const r = ormFor(this.db)
      .select({
        files: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${webUploads.bytes}), 0)`,
        blocks: sql<number>`coalesce(sum(max(1, (${webUploads.bytes} + ${BLOCK - 1}) / ${BLOCK}) * ${BLOCK}), 0)`,
      })
      .from(webUploads)
      .where(and(...where))
      .get();
    return { files: r?.files ?? 0, bytes: r?.bytes ?? 0, blocks: r?.blocks ?? 0 };
  }

  private sumBytes(direction: "in" | "out"): number {
    return this.usage(direction).bytes;
  }

  private checkQuota(direction: "in" | "out", size: number, now: number): void {
    const l = this.limits;
    if (direction === "in") {
      const today =
        ormFor(this.db)
          .select({ n: sql<number>`count(*)` })
          .from(webUploads)
          .where(and(eq(webUploads.direction, "in"), gte(webUploads.createdAt, now - DAY_MS)))
          .get()?.n ?? 0;
      if (today >= l.photosPerDay) throw new UploadError(429, "daily_limit", `at most ${l.photosPerDay} photos a day`);
      if (this.sumBytes("in") + size > l.photoCapBytes) throw new UploadError(507, "quota", "photo storage is full");
      return;
    }
    const cost = charged(size);
    const today = this.usage("out", now - DAY_MS);
    if (today.files >= l.agentFilesPerDay) throw new UploadError(507, "quota", "agent daily file count reached");
    if (today.blocks + cost > l.agentBytesPerDay) throw new UploadError(507, "quota", "agent daily file quota reached");
    const total = this.usage("out");
    if (total.files >= l.agentFileCap) throw new UploadError(507, "quota", "agent file count is at its cap");
    if (total.blocks + cost > l.agentCapBytes) throw new UploadError(507, "quota", "agent file storage is full");
  }

  private async ensureDiskSpace(size: number): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let free = await this.freeBytes(this.root);
    const now = this.now();
    if (free < this.limits.alertFreeBytes && now - this.lastLowDiskAlert >= LOW_DISK_ALERT_EVERY_MS) {
      this.lastLowDiskAlert = now;
      log.error({ freeBytes: free, root: this.root }, "web uploads disk is low on free space");
    }
    if (free - size >= this.limits.minFreeBytes) return;
    // Agent files go first; owner photos are never evicted automatically.
    const agentFiles = ormFor(this.db)
      .select()
      .from(webUploads)
      .where(and(eq(webUploads.direction, "out"), isNull(webUploads.deletedAt)))
      .orderBy(asc(webUploads.createdAt))
      .all();
    let evicted = 0;
    for (const row of agentFiles) {
      if (free - size >= this.limits.minFreeBytes) break;
      if (!(await this.remove(row, now))) continue;
      free += charged(row.bytes);
      evicted++;
    }
    if (evicted) log.warn({ evicted }, "evicted agent files to free disk space");
    free = await this.freeBytes(this.root);
    if (free - size < this.limits.minFreeBytes) {
      log.error({ freeBytes: free, size }, "web upload refused: disk nearly full");
      throw new UploadError(507, "disk_full", "the server is out of disk space");
    }
  }

  private checkPhotoWarning(): void {
    const { usedBytes, capBytes } = this.photoUsage();
    const orm = ormFor(this.db);
    const warned = orm.select().from(kv).where(eq(kv.key, PHOTO_WARNED_KEY)).get() !== undefined;
    const over = usedBytes >= capBytes * this.limits.photoWarnRatio;
    if (over && !warned) {
      orm.insert(kv).values({ key: PHOTO_WARNED_KEY, value: String(this.now()) }).onConflictDoNothing().run();
      log.warn({ usedBytes, capBytes }, "owner photo storage passed the warning threshold");
      try {
        this.onPhotoQuotaWarning?.(usedBytes, capBytes);
      } catch (err) {
        log.warn({ err }, "photo quota warning callback failed");
      }
    } else if (!over && warned) orm.delete(kv).where(eq(kv.key, PHOTO_WARNED_KEY)).run();
  }

  /** Soft-deletes the row, then its bytes. False when a reference or another delete got there first. */
  private async remove(row: Row, now: number): Promise<boolean> {
    // The guard re-checks referenced_at in the same statement: a photo attached since it was selected is kept.
    // Clearing the client key lets a later put with the same key store afresh.
    const gone = ormFor(this.db)
      .update(webUploads)
      .set({ deletedAt: now, clientKey: null })
      .where(and(eq(webUploads.id, row.id), isNull(webUploads.referencedAt), isNull(webUploads.deletedAt)))
      .returning({ id: webUploads.id })
      .all();
    if (!gone.length) return false;
    const abs = this.absPath(row.path);
    if (abs) await unlink(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") log.warn({ err, id: row.id }, "failed to delete upload bytes");
    });
    return true;
  }

  private async sweepTmp(now: number): Promise<void> {
    const dir = join(this.root, TMP_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      try {
        if (now - (await stat(p)).mtimeMs > 60 * 60 * 1000) await unlink(p);
      } catch {
        // Raced with a concurrent rename or delete.
      }
    }
  }
}

function stripDims(r: StoredUpload): UploadRef {
  return { id: r.id, contentType: r.contentType, bytes: r.bytes, name: r.name, inline: r.inline };
}

const GC_EVERY_MS = 60 * 60 * 1000;

/** Runs orphan GC now and hourly; the timer never keeps the process alive. */
export function scheduleUploadGc(store: UploadStore, now: () => number = Date.now): void {
  const run = () => void store.gcOrphans(now()).catch((err) => log.warn({ err }, "web upload GC failed"));
  run();
  setInterval(run, GC_EVERY_MS).unref?.();
}
