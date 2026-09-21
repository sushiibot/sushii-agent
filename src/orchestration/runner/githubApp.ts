import { createSign } from "node:crypto";
import { getLogger } from "../../logger.ts";
import type { RepoSpec } from "../contracts.ts";

const log = getLogger("orchestration.runner.githubApp");

export interface RepoToken {
  token: string;
  expiresAt: number; // epoch ms
}

// A re-callable source of a short-lived git credential scoped to one repo. The runner calls it
// again at push time rather than holding a token minted at dispatch — installation tokens expire
// in ~1h and a long task would otherwise push with a dead credential.
export interface GitTokenProvider {
  tokenFor(spec: RepoSpec): Promise<RepoToken>;
}

const GITHUB_API = "https://api.github.com";
const TOKEN_TTL_SLACK_MS = 5 * 60_000; // re-mint this long before expiry

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// App-level JWT (RS256), max 10 min lifetime; iat backdated 60s for clock skew (GitHub's guidance).
function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(nowMs / 1000) - 60;
  const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const data = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256").update(data).end().sign(privateKey);
  return `${data}.${b64url(sig)}`;
}

interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// Mints per-repo installation tokens for a GitHub App. Caches the installation id per owner/repo
// and the token until it nears expiry, so a clone-then-push task hits GitHub's API twice, not once
// per git op. The token never lands in .git/config or a process arg — repoOps passes it as a
// per-invocation http.extraHeader via env (see repoOps.ts).
export class GitHubAppTokenProvider implements GitTokenProvider {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly installationIds = new Map<string, number>();
  private readonly tokens = new Map<string, RepoToken>();

  constructor(opts: GitHubAppOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async tokenFor(spec: RepoSpec): Promise<RepoToken> {
    const key = `${spec.owner}/${spec.repo}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - this.now() > TOKEN_TTL_SLACK_MS) return cached;

    const jwt = appJwt(this.appId, this.privateKey, this.now());
    const installationId = await this.installationFor(spec, jwt);
    const res = await this.fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: this.appHeaders(jwt),
      // Scope the token to just this repo, so a token minted for one repo cannot touch another in
      // the same installation.
      body: JSON.stringify({ repositories: [spec.repo] }),
    });
    if (!res.ok) throw new Error(`mint installation token for ${key} failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    const minted: RepoToken = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    this.tokens.set(key, minted);
    return minted;
  }

  private async installationFor(spec: RepoSpec, jwt: string): Promise<number> {
    const key = `${spec.owner}/${spec.repo}`;
    const known = this.installationIds.get(key);
    if (known) return known;
    const res = await this.fetchImpl(`${GITHUB_API}/repos/${spec.owner}/${spec.repo}/installation`, {
      headers: this.appHeaders(jwt),
    });
    if (!res.ok) {
      throw new Error(
        `no GitHub App installation on ${key}: ${res.status} — install the App on this repo (${await res.text()})`,
      );
    }
    const body = (await res.json()) as { id: number };
    this.installationIds.set(key, body.id);
    return body.id;
  }

  private appHeaders(jwt: string): Record<string, string> {
    return {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }
}

// Build a provider from the runner's env, or null when the App is not configured (clone-on-demand
// then simply stays unavailable — dispatch with a repo is rejected rather than half-working).
export function tokenProviderFromEnv(env: NodeJS.ProcessEnv = process.env): GitTokenProvider | null {
  const appId = env.GITHUB_APP_ID?.trim();
  // Accept the PEM inline or as \n-escaped (how ansible vault / env vars usually carry it).
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!appId || !privateKey) {
    log.info("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset — clone-on-demand disabled on this runner");
    return null;
  }
  return new GitHubAppTokenProvider({ appId, privateKey });
}
