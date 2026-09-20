/** Normalize a relay URL the way the `buzz` CLI does internally — `wss://`→`https://`,
 *  `ws://`→`http://`, strip trailing slashes — plus lowercase, so scheme/casing/slash variants of
 *  the same relay collapse to one value. Used as the cursor + memory-space key, so two spellings of
 *  one community can't spawn two poll loops that double-answer every mention. */
export function normalizeRelayUrl(url: string): string {
  return url
    .trim()
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Parse BUZZ_RELAY_URL (comma-separated) into a normalized, deduped list of relay URLs. */
export function parseRelayUrls(raw: string | undefined): string[] {
  const seen = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeRelayUrl);
  return Array.from(new Set(seen));
}

/** Parse BUZZ_AVATAR_MAP (JSON: relay URL → avatar image URL) into a normalized relay-URL → URL map.
 *  buzz media is auth-gated per relay, so a viewer can only load the copy on their own relay — each
 *  community needs the avatar hosted on, and its profile pointed at, its own relay. Keys are
 *  normalized to match the per-relay loop key; a relay absent here falls back to BUZZ_AVATAR_URL. */
export function parseAvatarMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BUZZ_AVATAR_MAP must be valid JSON: {\"<relay url>\": \"<avatar url>\"}");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("BUZZ_AVATAR_MAP must be a JSON object of relay URL → avatar url");
  }
  const out: Record<string, string> = {};
  for (const [relay, url] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof url !== "string" || !url.trim()) continue;
    out[normalizeRelayUrl(relay)] = url.trim();
  }
  return out;
}

/** Parse BUZZ_WIKI_MAP (JSON: relay URL → Discord guild id) into a normalized relay-URL → guild-id
 *  map. Keys are normalized the same way as parseRelayUrls so they match the per-relay loop key, and
 *  a community reads a wiki only if its relay appears here — absence means no wiki access at all. */
export function parseWikiMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BUZZ_WIKI_MAP must be valid JSON: {\"<relay url>\": \"<guild id>\"}");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("BUZZ_WIKI_MAP must be a JSON object of relay URL → guild id");
  }
  const out: Record<string, string> = {};
  for (const [relay, guildId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof guildId !== "string" || !guildId.trim()) continue;
    out[normalizeRelayUrl(relay)] = guildId.trim();
  }
  return out;
}
