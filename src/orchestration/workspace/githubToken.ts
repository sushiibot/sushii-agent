import { githubTokenParams, type GitHubTokenResult } from "../contracts.ts";
import { GitHubAppNotInstalledError, type GitTokenProvider, type RepoToken } from "../github/githubApp.ts";
import type { BotIdentity } from "../github/repoOps.ts";
import type { ConnectionInfo } from "../transport/server.ts";
import { getLogger } from "../../logger.ts";

export const DEFAULT_BOT_IDENTITY: BotIdentity = { name: "sushii-runner[bot]", email: "sushii-runner@users.noreply.github.com" };
/** How long a repo the App can't serve is refused without asking GitHub again. */
export const NEGATIVE_TTL_MS = 60_000;

export interface GitHubTokenLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface GitHubTokenBrokerOptions {
  principalId: string;
  /** null: the App isn't configured, and every request is refused. */
  provider: GitTokenProvider | null;
  bot?: BotIdentity;
  now?: () => number;
  log?: GitHubTokenLog;
}

/** Serves `github/token`: the owner's workspace gets a repo-scoped installation token; the App key stays here.
 *  The provider caches each token until 5 min before expiry; this adds request coalescing and a short
 *  negative cache so an uninstalled repo doesn't cost two GitHub calls per bash command. */
export class GitHubTokenBroker {
  private readonly bot: BotIdentity;
  private readonly now: () => number;
  private readonly log: GitHubTokenLog;
  private readonly inflight = new Map<string, Promise<RepoToken>>();
  private readonly refused = new Map<string, { error: string; until: number }>();

  constructor(private readonly opts: GitHubTokenBrokerOptions) {
    this.bot = opts.bot ?? DEFAULT_BOT_IDENTITY;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? getLogger("orchestration/workspace/github");
  }

  async handle(conn: ConnectionInfo, raw: unknown): Promise<GitHubTokenResult> {
    const parsed = githubTokenParams.safeParse(raw);
    if (!parsed.success) return this.outcome("", { ok: false, error: `invalid github/token params: ${parsed.error.issues[0]?.message ?? "malformed"}` });
    const { principalId, repo } = parsed.data;
    if (principalId !== this.opts.principalId || conn.principalId !== this.opts.principalId) return this.outcome(repo, { ok: false, error: "principal mismatch" });
    if (!this.opts.provider) return this.outcome(repo, { ok: false, error: "the GitHub App is not configured on the bot" });

    const key = repo.toLowerCase();
    const refused = this.refused.get(key);
    if (refused && refused.until > this.now()) return this.outcome(repo, { ok: false, error: refused.error }, true);
    this.refused.delete(key);

    let pending = this.inflight.get(key);
    if (!pending) {
      const [owner, name] = repo.split("/") as [string, string];
      pending = this.opts.provider.tokenFor({ owner, repo: name }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      const minted = await pending;
      return this.outcome(repo, { ok: true, token: minted.token, expiresAt: minted.expiresAt, botName: this.bot.name, botEmail: this.bot.email });
    } catch (err) {
      const error =
        err instanceof GitHubAppNotInstalledError
          ? `the sushii GitHub App is not installed on ${repo} (or the repo doesn't exist)`
          : `minting a GitHub token for ${repo} failed`;
      this.refused.set(key, { error, until: this.now() + NEGATIVE_TTL_MS });
      this.log.warn({ repo, err: err instanceof Error ? err.message : String(err) }, "github/token: GitHub refused");
      return this.outcome(repo, { ok: false, error });
    }
  }

  private outcome(repo: string, result: GitHubTokenResult, cached = false): GitHubTokenResult {
    if (result.ok) this.log.info({ repo, ok: true, expiresAt: result.expiresAt }, "github/token");
    else this.log.info({ repo, ok: false, error: result.error, ...(cached ? { cached } : {}) }, "github/token");
    return result;
  }
}
