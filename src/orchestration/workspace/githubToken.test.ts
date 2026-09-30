import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { runnerGitEnv } from "../../agentRuntime/runnerGit.ts";
import { GitHubCredentials } from "../../workspace/githubCredentials.ts";
import { createWorkspaceBashTool } from "../../workspace/piChatSession.ts";
import { RPC_METHODS, type GitHubTokenResult } from "../contracts.ts";
import { GitHubAppTokenProvider, type GitTokenProvider, type RepoSpec, type RepoToken } from "../github/githubApp.ts";
import { OrchestrationClient } from "../transport/client.ts";
import { OrchestrationServer, type ConnectionInfo } from "../transport/server.ts";
import { GitHubTokenBroker, NEGATIVE_TTL_MS } from "./githubToken.ts";
import { WorkspaceLink } from "./link.ts";
import { SurfaceRegistry } from "./surface.ts";

const P = "drk";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };
const TOKEN = "ghs_brokerbrokerbroker0123456789";
const BOT = { name: "sushii-runner[bot]", email: "runner@users.noreply.github.com" };

class FakeProvider implements GitTokenProvider {
  calls: RepoSpec[] = [];
  gate: Promise<void> | null = null;
  constructor(private readonly mint: (spec: RepoSpec) => RepoToken | Error = () => ({ token: TOKEN, expiresAt: 5_000_000 })) {}
  async tokenFor(spec: RepoSpec): Promise<RepoToken> {
    this.calls.push(spec);
    if (this.gate) await this.gate;
    const out = this.mint(spec);
    if (out instanceof Error) throw out;
    return out;
  }
}

function capture() {
  const lines: Array<{ obj: object; msg: string }> = [];
  return { lines, log: { info: (obj: object, msg: string) => lines.push({ obj, msg }), warn: (obj: object, msg: string) => lines.push({ obj, msg }) } };
}

function fakeGitHub(installationStatus: number): typeof fetch {
  return (async (url: string) => {
    if (String(url).endsWith("/installation")) {
      return installationStatus === 200
        ? { ok: true, status: 200, json: async () => ({ id: 7 }), text: async () => "" }
        : { ok: false, status: installationStatus, json: async () => ({}), text: async () => '{"message":"Not Found","secret_detail":"raw-github-body"}' };
    }
    return { ok: true, status: 201, json: async () => ({ token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }), text: async () => "" };
  }) as unknown as typeof fetch;
}

const testKey = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("github/token broker", () => {
  test("the owner's workspace gets a token and the App's commit identity; the log carries the repo, never the token", async () => {
    const { lines, log } = capture();
    const provider = new FakeProvider();
    const broker = new GitHubTokenBroker({ principalId: P, provider, bot: BOT, log });
    expect(await broker.handle(CONN, { principalId: P, repo: "acme/widgets" })).toEqual({ ok: true, token: TOKEN, expiresAt: 5_000_000, botName: BOT.name, botEmail: BOT.email });
    expect(provider.calls).toEqual([{ owner: "acme", repo: "widgets" }]);
    expect(lines).toEqual([{ obj: { repo: "acme/widgets", ok: true, expiresAt: 5_000_000 }, msg: "github/token" }]);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  test("owner only: another principal on the params or the connection is refused", async () => {
    const provider = new FakeProvider();
    const broker = new GitHubTokenBroker({ principalId: P, provider, log: capture().log });
    expect(await broker.handle(CONN, { principalId: "mallory", repo: "acme/widgets" })).toEqual({ ok: false, error: "principal mismatch" });
    expect(await broker.handle({ ...CONN, principalId: "mallory" }, { principalId: "mallory", repo: "acme/widgets" })).toEqual({ ok: false, error: "principal mismatch" });
    expect(await broker.handle({ ...CONN, principalId: "mallory" }, { principalId: P, repo: "acme/widgets" })).toEqual({ ok: false, error: "principal mismatch" });
    expect(provider.calls).toEqual([]);
  });

  test("a malformed repo never reaches GitHub", async () => {
    const provider = new FakeProvider();
    const broker = new GitHubTokenBroker({ principalId: P, provider, log: capture().log });
    for (const repo of ["acme", "acme/..", "acme/widgets/extra", "../x/y", "acme/wid gets", "acme/widgets?x=1"]) {
      const res = await broker.handle(CONN, { principalId: P, repo });
      expect(res.ok).toBe(false);
    }
    expect(provider.calls).toEqual([]);
  });

  test("unconfigured App: a clean refusal", async () => {
    const broker = new GitHubTokenBroker({ principalId: P, provider: null, log: capture().log });
    expect(await broker.handle(CONN, { principalId: P, repo: "acme/widgets" })).toEqual({ ok: false, error: "the GitHub App is not configured on the bot" });
  });

  test("App not installed: a clean refusal without GitHub's raw body, cached briefly", async () => {
    const { lines, log } = capture();
    let now = 1_000;
    let lookups = 0;
    const provider = new GitHubAppTokenProvider({
      appId: "1",
      privateKey: testKey(),
      fetchImpl: ((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/installation")) lookups++;
        return fakeGitHub(404)(url, init);
      }) as unknown as typeof fetch,
    });
    const broker = new GitHubTokenBroker({ principalId: P, provider, log, now: () => now });
    const refused: GitHubTokenResult = { ok: false, error: "the sushii GitHub App is not installed on acme/widgets (or the repo doesn't exist)" };
    expect(await broker.handle(CONN, { principalId: P, repo: "acme/widgets" })).toEqual(refused);
    expect(await broker.handle(CONN, { principalId: P, repo: "acme/widgets" })).toEqual(refused);
    expect(lookups).toBe(1);
    now += NEGATIVE_TTL_MS + 1;
    await broker.handle(CONN, { principalId: P, repo: "acme/widgets" });
    expect(lookups).toBe(2);
    expect(JSON.stringify(await broker.handle(CONN, { principalId: P, repo: "acme/widgets" }))).not.toContain("raw-github-body");
    expect(lines.some((l) => (l.obj as { ok?: boolean }).ok === false)).toBe(true);
  });

  test("the real provider caches per repo: two requests, one mint", async () => {
    let mints = 0;
    const provider = new GitHubAppTokenProvider({
      appId: "1",
      privateKey: testKey(),
      fetchImpl: ((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/access_tokens")) mints++;
        return fakeGitHub(200)(url, init);
      }) as unknown as typeof fetch,
    });
    const broker = new GitHubTokenBroker({ principalId: P, provider, log: capture().log });
    const a = await broker.handle(CONN, { principalId: P, repo: "acme/widgets" });
    const b = await broker.handle(CONN, { principalId: P, repo: "acme/widgets" });
    expect(a.ok && b.ok && a.token === b.token).toBe(true);
    expect(mints).toBe(1);
  });

  test("concurrent requests for one repo share a single mint", async () => {
    const provider = new FakeProvider();
    let open!: () => void;
    provider.gate = new Promise((r) => (open = r));
    const broker = new GitHubTokenBroker({ principalId: P, provider, log: capture().log });
    const both = Promise.all([broker.handle(CONN, { principalId: P, repo: "acme/widgets" }), broker.handle(CONN, { principalId: P, repo: "Acme/Widgets" })]);
    open();
    expect((await both).every((r) => r.ok)).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("github/token through the real transport", () => {
  test("a workspace bash call in a github checkout runs with the bot-minted token; without a broker it runs bare", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-e2e-"));
    const home = join(root, "home");
    const repo = join(home, "projects", "acme-widgets");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: runnerGitEnv() });
    git("init", "--initial-branch=main");
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");

    const provider = new FakeProvider();
    const run = async (github: GitHubTokenBroker | undefined) => {
      const server = new OrchestrationServer({ secretGrants: { secret: { principalId: P } } });
      const link = new WorkspaceLink({
        principalId: P,
        store: newStore(),
        surfaces: new SurfaceRegistry("test"),
        owner: () => ({ id: "owner-1", name: "drk" }),
        github,
      });
      link.attach(server);
      server.listen();
      const client = new OrchestrationClient({ url: server.url, runnerId: `workspace-${P}`, kind: "pi-workspace", secret: "secret", principalId: P, state: "idle", heartbeatMs: 0 });
      try {
        await client.connect();
        client.listen();
        const creds = new GitHubCredentials({ principalId: P, home, askpassPath: join(root, "state", "askpass.sh"), request: (m, p, t) => client.request(m, p, { timeoutMs: t }), log: capture().log });
        const tool = await createWorkspaceBashTool(home, () => null, creds);
        const res = await tool.execute("c1", { command: 'cd projects/acme-widgets && printf "%s|%s" "$GH_TOKEN" "$GIT_COMMITTER_NAME"' }, undefined, undefined, undefined as never);
        const direct = (await client.request(RPC_METHODS.githubToken, { principalId: P, repo: "acme/widgets" })) as GitHubTokenResult;
        return { out: (res.content as Array<{ text: string }>)[0]!.text, direct };
      } finally {
        client.close();
        server.stop();
      }
    };
    try {
      const withApp = await run(new GitHubTokenBroker({ principalId: P, provider, bot: BOT, log: capture().log }));
      expect(withApp.out).toBe(`${TOKEN}|${BOT.name}`);
      expect(provider.calls).toHaveLength(2);
      const bare = await run(undefined);
      expect(bare.out).toBe("|");
      expect(bare.direct).toEqual({ ok: false, error: "the GitHub App is not configured on the bot" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function newStore(): WorkspaceLinkStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new WorkspaceLinkStore(db);
}
