// Upload an avatar image to a buzz relay's Blossom media store and print the hosted URL.
//
// buzz hosts avatars on the relay's own content-addressed media server (Blossom). This uploads an
// image once, signed with the bot's key, and prints the {relay}/{sha256} URL to set as
// BUZZ_AVATAR_URL. buzz clients render it as a plain <img>, so the URL is stable and public.
//
// Usage (agent key from BUZZ_PRIVATE_KEY, relay from BUZZ_RELAY_URL unless --relay given):
//   BUZZ_PRIVATE_KEY=<nsec|hex> bun run scripts/upload-buzz-avatar.ts --file ./avatar.png
//   BUZZ_PRIVATE_KEY=<nsec|hex> bun run scripts/upload-buzz-avatar.ts --url <image url>  # e.g. the Discord avatar
//   ... [--relay wss://buzz.dreamcatcher.inc]

import { finalizeEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function decodeSecretKey(raw: string): Uint8Array {
  const key = raw.trim();
  if (key.startsWith("nsec")) {
    const decoded = nip19.decode(key);
    if (decoded.type !== "nsec") throw new Error("BUZZ_PRIVATE_KEY is not a valid nsec");
    return decoded.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Uint8Array.from(Buffer.from(key, "hex"));
  throw new Error("BUZZ_PRIVATE_KEY must be 64-char hex or an nsec");
}

/** Blossom validates by content, so detect the MIME from magic bytes rather than trusting a name. */
function detectImageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  throw new Error("unsupported image type (expected png, jpeg, gif, or webp)");
}

/** wss://host → https://host; also accepts an https:// relay URL directly. Returns [apiBase, authority]. */
function relayApiBase(relay: string): [string, string] {
  const u = new URL(relay.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://"));
  const authority = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return [`${u.protocol}//${authority}`, authority];
}

async function loadImage(): Promise<Uint8Array> {
  const file = arg("--file");
  const url = arg("--url");
  if (file) return new Uint8Array(await Bun.file(file).arrayBuffer());
  if (url) {
    const res = await fetch(url);
    if (!res.ok) fail(`could not download --url: ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  fail("pass --file <path> or --url <image url>");
}

const keyRaw = process.env["BUZZ_PRIVATE_KEY"];
if (!keyRaw) fail("set BUZZ_PRIVATE_KEY (the bot's nsec or hex) in the environment");
const sk = decodeSecretKey(keyRaw);

const relay = arg("--relay") ?? process.env["BUZZ_RELAY_URL"]?.split(",")[0]?.trim();
if (!relay) fail("pass --relay <wss url> or set BUZZ_RELAY_URL");
const [apiBase, authority] = relayApiBase(relay);

const body = await loadImage();
const mime = detectImageMime(body);
const hash = bytesToHex(sha256(body));

// Blossom BUD-02 upload auth: a kind:24242 event the relay verifies before accepting the PUT.
const now = Math.floor(Date.now() / 1000);
const authEvent = finalizeEvent(
  {
    kind: 24242,
    created_at: now,
    content: "Upload buzz-media",
    tags: [["t", "upload"], ["x", hash], ["expiration", String(now + 300)], ["server", authority]],
  },
  sk,
);
const authHeader = `Nostr ${Buffer.from(JSON.stringify(authEvent)).toString("base64url")}`;

async function put(url: string): Promise<Response> {
  return fetch(url, {
    method: "PUT",
    headers: { Authorization: authHeader, "Content-Type": mime, "X-SHA-256": hash },
    body,
  });
}

let res = await put(`${apiBase}/upload`);
if (res.status === 404 || res.status === 405) res = await put(`${apiBase}/media/upload`); // legacy endpoint
if (!res.ok) fail(`upload failed: ${res.status} ${res.statusText}\n${await res.text().catch(() => "")}`);

const blob = (await res.json()) as { url?: string; sha256?: string };
if (!blob.url) fail(`upload returned no url: ${JSON.stringify(blob)}`);

console.error(`relay:   ${relay}`);
console.error(`mime:    ${mime}`);
console.error(`sha256:  ${blob.sha256 ?? hash}`);
console.error("");
console.error("BUZZ_AVATAR_URL (paste as-is):");
console.log(blob.url);
