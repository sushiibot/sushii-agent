// One list for both ws-runs output redaction and the memory guard, so what counts as a secret can't drift.

const BLOB = /[A-Za-z0-9+_=-]{32,}/g;

// Kebab/snake identifiers, UUIDs and session file names are long runs of the blob class too, but
// split into short words; random tokens have a long unbroken alphanumeric stretch with a digit.
function looksRandom(token: string): boolean {
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  return token.split(/[-_]/).some((part) => part.length >= 16 && /[0-9]/.test(part) && /[A-Za-z]/.test(part));
}

/** Shape-matched secrets, replaced whole. Order matters: multi-part shapes before their parts. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // JWTs, including a lone header/payload segment.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g,
  /\beyJ[A-Za-z0-9_-]{30,}/g,
  // Three dot-separated segments: Discord bot tokens and similar signed tokens.
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}/g,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![0-9A-Fa-f])[0-9A-Fa-f]{40,}(?![0-9A-Fa-f])/g,
];

export const REDACTED = "[REDACTED]";

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (/^Bearer\s/i.test(m) ? `Bearer ${REDACTED}` : REDACTED));
  }
  return out.replace(BLOB, (m) => (looksRandom(m) ? REDACTED : m));
}

export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}
