const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-char ULID (48-bit ms timestamp + 80 random bits, Crockford base32). */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[bytes[i] % 32];
  return time + random;
}
