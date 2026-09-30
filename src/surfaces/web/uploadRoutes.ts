import { UPLOAD_READ_BUSY, uploadReadParams, uploadReadResult, type UploadReadResult } from "../../orchestration/contracts.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import { getLogger } from "../../logger.ts";
import { UPLOAD_ID_RE, UPLOAD_MAX_BYTES, type UploadResponse } from "./events.ts";
import { readBodyCapped } from "./server.ts";
import { UploadError, type DiskUploadStore, type UploadStore } from "./uploads.ts";

const log = getLogger("web-uploads");

const NO_STORE = "no-store";
/** Per-file idempotency key from the app, e.g. `<message ULID>-<n>`; never the bare message id shared by several photos. */
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RAW_NAME_MAX = 1024;
export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self'";
const IMMUTABLE = "private, max-age=31536000, immutable";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

/** RFC 6266 Content-Disposition with an RFC 8187 (ex-5987) `filename*`, plus a plain ASCII fallback. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const clean = name.replace(/[\r\n"]/g, "");
  // encodeURIComponent leaves '()*! unescaped, and ' delimits the ext-value.
  const encoded = encodeURIComponent(clean).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/[\\%;]/g, "_") || "file";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** `X-Upload-Name` is percent-encoded UTF-8, since header values can only carry bytes. */
function decodeUploadName(raw: string | null): string {
  if (!raw) return "";
  const capped = raw.slice(0, RAW_NAME_MAX);
  try {
    return decodeURIComponent(capped);
  } catch {
    return capped;
  }
}

/** POST /api/uploads. The caller has already checked the peer, the owner login and isSameOrigin. */
export async function handleUploadPost(req: Request, store: UploadStore): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // image/* is not a CORS-simple type, so a cross-site form or fetch can't send it without a preflight.
  const type = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("image/")) return json({ error: "content-type must be an image type" }, 415);
  const lengthHeader = req.headers.get("Content-Length");
  if (lengthHeader !== null && !(/^\d+$/.test(lengthHeader) && Number(lengthHeader) <= UPLOAD_MAX_BYTES)) {
    return json({ error: "body too large" }, 413);
  }
  const clientKey = req.headers.get("X-Client-Id") ?? undefined;
  if (clientKey !== undefined && !CLIENT_KEY_RE.test(clientKey)) return json({ error: "invalid X-Client-Id" }, 400);
  const bytes = await readBodyCapped(req, UPLOAD_MAX_BYTES);
  if (!bytes) return json({ error: "body too large" }, 413);
  if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);
  try {
    const ref = await store.put({ bytes, name: decodeUploadName(req.headers.get("X-Upload-Name")), direction: "in", ...(clientKey ? { clientKey } : {}) });
    const body: UploadResponse = {
      id: ref.id,
      contentType: ref.contentType,
      bytes: ref.bytes,
      ...(ref.width !== undefined ? { width: ref.width } : {}),
      ...(ref.height !== undefined ? { height: ref.height } : {}),
    };
    return json(body);
  } catch (err) {
    if (err instanceof UploadError) return json({ error: err.code, message: err.message }, err.status);
    throw err;
  }
}

function fileHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    "Content-Security-Policy": FILE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
}

function fileError(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, { status, headers: fileHeaders({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE, ...extra }) });
}

/** GET /f/:id. Only a sniffed raster is served inline; everything else downloads as an opaque attachment. */
export async function handleFileGet(req: Request, path: string, store: UploadStore): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return fileError(405, "Method Not Allowed", { Allow: "GET, HEAD" });
  const site = req.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") return fileError(403, "Forbidden");
  const id = path.startsWith("/f/") ? path.slice(3) : "";
  if (!UPLOAD_ID_RE.test(id)) return fileError(404, "Not Found");
  const hit = await store.get(id);
  if (!hit) return fileError(404, "Not Found");
  const { meta, body } = hit;
  const headers = fileHeaders({
    "Content-Type": meta.inline ? meta.contentType : "application/octet-stream",
    "Content-Disposition": contentDisposition(meta.inline ? "inline" : "attachment", meta.name),
    "Cache-Control": IMMUTABLE,
  });
  return new Response(req.method === "HEAD" ? null : body, { headers });
}

export interface UploadReadLimits {
  maxInFlight: number;
  /** Raw file bytes across reads in flight; each read also holds its base64 and JSON copies until sent. */
  maxInFlightBytes: number;
}

export const DEFAULT_UPLOAD_READ_LIMITS: UploadReadLimits = { maxInFlight: 2, maxInFlightBytes: 16 * 1024 * 1024 };

/** Serves `upload/read`: the workspace's only way to get an owner photo's bytes. Over the concurrency or byte
 *  budget it answers "busy" rather than queueing, so a burst can't pile up whole files in memory. */
export function createUploadReadHandler(
  store: Pick<DiskUploadStore, "readReferenced" | "referencedSize">,
  principalId: string,
  limits: UploadReadLimits = DEFAULT_UPLOAD_READ_LIMITS,
) {
  let inFlight = 0;
  let inFlightBytes = 0;
  return async (conn: ConnectionInfo, params: unknown): Promise<UploadReadResult> => {
    const p = uploadReadParams.safeParse(params);
    if (!p.success) return { ok: false, error: "invalid params" };
    if (p.data.principalId !== conn.principalId || p.data.principalId !== principalId) return { ok: false, error: "principal mismatch" };
    const size = store.referencedSize(p.data.uploadId);
    if (size === null) {
      log.warn({ uploadId: p.data.uploadId }, "upload/read refused: unknown or unreferenced upload");
      return { ok: false, error: "not found" };
    }
    if (inFlight >= limits.maxInFlight || inFlightBytes + size > limits.maxInFlightBytes) {
      log.warn({ uploadId: p.data.uploadId, inFlight, inFlightBytes }, "upload/read refused: busy");
      return { ok: false, error: UPLOAD_READ_BUSY };
    }
    inFlight++;
    inFlightBytes += size;
    try {
      const file = await store.readReferenced(p.data.uploadId);
      if (!file) return { ok: false, error: "not found" };
      const result = uploadReadResult.safeParse({ ok: true, name: file.name, contentType: file.contentType, dataBase64: Buffer.from(file.bytes).toString("base64") });
      if (!result.success) return { ok: false, error: "upload is not readable" };
      return result.data;
    } finally {
      inFlight--;
      inFlightBytes -= size;
    }
  };
}
