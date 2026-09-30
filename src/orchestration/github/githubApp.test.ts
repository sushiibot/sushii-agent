import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubAppTokenProvider, tokenProviderFromEnv } from "./githubApp.ts";

function testKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function fakeFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++] ?? responses[responses.length - 1];
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("GitHubAppTokenProvider", () => {
  test("mints a repo-scoped installation token: JWT lookup then token request", async () => {
    const { impl, calls } = fakeFetch([
      { body: { id: 4242 } }, // GET installation
      { body: { token: "ghs_abc", expires_at: new Date(Date.now() + 3600_000).toISOString() } }, // POST token
    ]);
    const provider = new GitHubAppTokenProvider({ appId: "123", privateKey: testKey(), fetchImpl: impl });

    const token = await provider.tokenFor({ owner: "acme", repo: "widgets" });

    expect(token.token).toBe("ghs_abc");
    expect(calls[0].url).toContain("/repos/acme/widgets/installation");
    expect(calls[1].url).toContain("/app/installations/4242/access_tokens");
    // Token is scoped to just the one repo.
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ repositories: ["widgets"] });
    // App-level calls authenticate with a 3-part JWT bearer.
    const auth = (calls[0].init!.headers as Record<string, string>).Authorization;
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(auth.slice(7).split(".").length).toBe(3);
  });

  test("caches the token until it nears expiry, and the installation id across calls", async () => {
    let now = 1_000_000;
    const { impl, calls } = fakeFetch([
      { body: { id: 7 } },
      { body: { token: "t1", expires_at: new Date(now + 3600_000).toISOString() } },
      { body: { token: "t2", expires_at: new Date(now + 7200_000).toISOString() } },
    ]);
    const provider = new GitHubAppTokenProvider({ appId: "1", privateKey: testKey(), fetchImpl: impl, now: () => now });
    const spec = { owner: "a", repo: "b" };

    const first = await provider.tokenFor(spec);
    const cached = await provider.tokenFor(spec);
    expect(cached.token).toBe(first.token);
    expect(calls.length).toBe(2); // no re-mint, no re-lookup

    now += 3600_000; // past expiry-minus-slack
    const refreshed = await provider.tokenFor(spec);
    expect(refreshed.token).toBe("t2");
    // Installation id was cached — only the token POST repeated, not the installation GET.
    expect(calls.filter((c) => c.url.includes("/access_tokens")).length).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/installation")).length).toBe(1);
  });

  test("surfaces a missing installation as an actionable error", async () => {
    const { impl } = fakeFetch([{ ok: false, status: 404, body: { message: "Not Found" } }]);
    const provider = new GitHubAppTokenProvider({ appId: "1", privateKey: testKey(), fetchImpl: impl });
    await expect(provider.tokenFor({ owner: "a", repo: "b" })).rejects.toThrow(/no GitHub App installation/);
  });

  test("tokenProviderFromEnv returns null when unconfigured", () => {
    expect(tokenProviderFromEnv({})).toBeNull();
    expect(tokenProviderFromEnv({ GITHUB_APP_ID: "1" })).toBeNull();
  });
});
