import type { DiscordIdentity } from "./session.ts";

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const ME_URL = "https://discord.com/api/users/@me";

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  return url.toString();
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
}

interface DiscordUserResponse {
  id: string;
  username: string;
  avatar: string | null;
}

/**
 * Exchanges an authorization code for a Discord identity. The Discord access token
 * is used only for the /users/@me call within this function and is never returned —
 * the caller is responsible for minting its own session token from the result.
 */
export async function resolveIdentityFromCode(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<DiscordIdentity> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { access_token, token_type } = (await tokenRes.json()) as DiscordTokenResponse;

  const meRes = await fetch(ME_URL, {
    headers: { Authorization: `${token_type} ${access_token}` },
  });
  if (!meRes.ok) {
    throw new Error(`Discord /users/@me failed: ${meRes.status} ${await meRes.text()}`);
  }
  const me = (await meRes.json()) as DiscordUserResponse;

  return { id: me.id, username: me.username, avatar: me.avatar };
}
