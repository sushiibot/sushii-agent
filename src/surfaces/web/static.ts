import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const NO_CACHE = "no-cache";

export type StaticResolution =
  | { kind: "file"; path: string; fallback: boolean }
  | { kind: "not-found" }
  | { kind: "bad-request" };

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realpathOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** The file's real path if it is a regular file whose real location is inside realRoot; symlinks out are refused. */
function containedFile(realRoot: string, candidate: string): string | undefined {
  const real = realpathOrUndefined(candidate);
  if (!real || !real.startsWith(realRoot + sep)) return undefined;
  return isFile(real) ? real : undefined;
}

/** Maps a URL pathname to a file under distDir, falling back to index.html for extensionless
 *  client routes. Anything that decodes to a path outside distDir is a bad request. */
export function resolveStatic(distDir: string, pathname: string): StaticResolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "bad-request" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return { kind: "bad-request" };
  const root = resolve(distDir);
  const target = resolve(root, "." + decoded);
  if (target !== root && !target.startsWith(root + sep)) return { kind: "bad-request" };
  // Dotfiles and dot-dirs are never part of a build's public output.
  if (decoded.split("/").some((seg) => seg.startsWith("."))) return { kind: "not-found" };

  const realRoot = realpathOrUndefined(root);
  if (!realRoot) return { kind: "not-found" };
  for (const candidate of [target, `${target}.html`, resolve(target, "index.html")]) {
    if (candidate !== root && !candidate.startsWith(root + sep)) continue;
    const real = containedFile(realRoot, candidate);
    if (real) return { kind: "file", path: real, fallback: false };
  }
  if (extname(decoded) !== "") return { kind: "not-found" };
  const index = containedFile(realRoot, resolve(root, "index.html"));
  return index ? { kind: "file", path: index, fallback: true } : { kind: "not-found" };
}

export function cacheControlFor(pathname: string, fallback: boolean): string {
  if (!fallback && pathname.startsWith("/_app/immutable/")) return IMMUTABLE_CACHE;
  return NO_CACHE;
}

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** CSP sha256 sources for every inline <script> in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
    const body = m[2] ?? "";
    if (body.length === 0) continue;
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

/** Trusted Types policies the SPA creates: Svelte's template policy, and the app's service-worker URL
 *  policy in web/src/lib/app/trusted-types.ts. Any other createPolicy call throws. */
export const TRUSTED_TYPE_POLICIES = ["svelte-trusted-html", "sushii-sw-url"] as const;

export function buildCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    // Svelte transitions and component libraries set inline styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    // data: is the build-inlined favicon; blob: is local photo previews.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    ["trusted-types", ...TRUSTED_TYPE_POLICIES].join(" "),
  ].join("; ");
}

export const BASE_CSP = buildCsp([]);

/** Per-file CSP cache, keyed by path and invalidated by mtime so a rebuilt dist picks up new hashes. */
export class HtmlCspCache {
  private readonly cache = new Map<string, { mtimeMs: number; csp: string }>();

  async get(path: string): Promise<string> {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.csp;
    const csp = buildCsp(inlineScriptHashes(await Bun.file(path).text()));
    this.cache.set(path, { mtimeMs, csp });
    return csp;
  }
}
