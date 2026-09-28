const DISCORD_MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const URL_RE = /https?:\/\/[^\s<>()]+/gi;
export const MAX_IMAGES_PER_MESSAGE = 3;

export interface ImageLink {
  url: string;
  /** Host- and signature-independent key: cdn/media hosts serve the same path, and the signed
   *  `ex`/`is`/`hm` params change every time a link is re-shared. */
  key: string;
}

export function discordImageLink(raw: string): ImageLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !DISCORD_MEDIA_HOSTS.has(u.hostname)) return null;
  if (!IMAGE_EXT.test(u.pathname)) return null;
  return { url: u.toString(), key: u.pathname };
}

/** Discord-hosted image links in the message: pasted CDN/media links, plus link-unfurl embed
 *  images when Discord generated any. Never returns a third-party URL. */
export function extractImageLinks(
  content: string,
  embeds: readonly { image?: { proxyURL?: string | null } | null; thumbnail?: { proxyURL?: string | null } | null }[] = [],
): ImageLink[] {
  const candidates = [...(content.match(URL_RE) ?? [])];
  for (const e of embeds) {
    if (e.image?.proxyURL) candidates.push(e.image.proxyURL);
    else if (e.thumbnail?.proxyURL) candidates.push(e.thumbnail.proxyURL);
  }
  const seen = new Set<string>();
  const out: ImageLink[] = [];
  for (const c of candidates) {
    const link = discordImageLink(c);
    if (!link || seen.has(link.key)) continue;
    seen.add(link.key);
    out.push(link);
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
  }
  return out;
}
