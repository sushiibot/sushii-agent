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
