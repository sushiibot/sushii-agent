export const NO_STORE = "no-store";
export const MAX_BODY_BYTES = 8 * 1024;

export function forbidden(): Response {
  return new Response("Forbidden\n", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE } });
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

/** Ambient Serve identity makes cross-site writes a CSRF risk, so writes must be same-origin. */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  return site !== null ? site === "same-origin" : req.headers.get("Origin") === null;
}

export function isJson(req: Request): boolean {
  const type = req.headers.get("Content-Type") ?? "";
  return type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Reads at most `limit` bytes, whether or not the body is chunked; undefined once the limit is exceeded. */
export async function readBodyCapped(req: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body of at most `limit` bytes; a Response is the error to return. */
export async function readJson(req: Request, limit = MAX_BODY_BYTES): Promise<unknown | Response> {
  const lengthHeader = req.headers.get("Content-Length");
  if (lengthHeader !== null && !(/^\d+$/.test(lengthHeader) && Number(lengthHeader) <= limit)) {
    return json({ error: "body too large" }, 413);
  }
  const bytes = await readBodyCapped(req, limit);
  if (!bytes) return json({ error: "body too large" }, 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
}

