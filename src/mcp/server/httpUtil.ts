import { config } from "../../config.ts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function errorPage(title: string, message: string): string {
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><p>${escapeHtml(message)}</p></body></html>`;
}

/** Returns the Discord OAuth app credentials, or null if any are unconfigured. */
export function oauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const { discordOAuthClientId, discordOAuthClientSecret, discordOAuthRedirectUri } = config;
  if (!discordOAuthClientId || !discordOAuthClientSecret || !discordOAuthRedirectUri) return null;
  return { clientId: discordOAuthClientId, clientSecret: discordOAuthClientSecret, redirectUri: discordOAuthRedirectUri };
}

/**
 * The externally-visible origin (scheme + host) this server is reached at. Derived from
 * DISCORD_OAUTH_REDIRECT_URI rather than the request URL, since Traefik terminates TLS and
 * forwards plain HTTP internally — the request's own URL would report "http" even when the
 * client connected over https.
 */
export function publicOrigin(requestUrl: string): string {
  const oauth = oauthConfig();
  return oauth ? new URL(oauth.redirectUri).origin : new URL(requestUrl).origin;
}

const OAUTH_RESPONSE_PARAMS = ["code", "state", "error", "error_description"] as const;

/**
 * Builds an OAuth response redirect back to a client's redirect_uri. Always clears the standard
 * response params first, even ones not being set here — a client can register a redirect_uri
 * that already has e.g. ?code=... in its query string, and without this a stale value from that
 * registration would survive alongside (or instead of) the one we're actually issuing.
 *
 * redirectUri is expected to have already passed isAllowedRedirectUri, so `new URL` shouldn't
 * throw here — but the two checks are for the same value at different times, so fail closed
 * rather than let a parse error become an unhandled 500.
 */
export function buildOAuthResponseRedirect(redirectUri: string, params: Record<string, string | undefined>): string | null {
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return null;
  }
  for (const key of OAUTH_RESPONSE_PARAMS) target.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  return target.toString();
}
