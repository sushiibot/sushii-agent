type Parsed = { v: 4; n: bigint } | { v: 6; n: bigint };

function parseIPv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = (n << 8n) | BigInt(b);
  }
  return n;
}

function parseIPv6(s: string): bigint | null {
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  let tail: bigint[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail = [v4 >> 16n, v4 & 0xffffn];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail.length) n = (n & ~0xffffffffn) | (tail[0]! << 16n) | tail[1]!;
  return n;
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;

/** Parses an IP, folding IPv4-mapped IPv6 (::ffff:a.b.c.d) into plain IPv4. */
export function parseIp(raw: string): Parsed | null {
  const v4 = parseIPv4(raw);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseIPv6(raw);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & ~V4_MAPPED_PREFIX };
  return { v: 6, n: v6 };
}

export type PeerMatcher = (ip: string | null | undefined) => boolean;

/** Exact-IP allowlist: no ranges, so no other container on a shared bridge can ever qualify. */
export function createPeerMatcher(entries: string[]): PeerMatcher {
  const allowed = entries.map((entry) => {
    const ip = parseIp(entry.trim());
    if (!ip) throw new Error(`invalid trusted peer address (exact IPs only): ${entry}`);
    return ip;
  });
  return (raw) => {
    if (!raw) return false;
    const ip = parseIp(raw);
    if (!ip) return false;
    return allowed.some((a) => a.v === ip.v && a.n === ip.n);
  };
}
