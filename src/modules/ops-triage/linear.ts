import { LinearClient, LinearDocument, type Issue } from "@linear/sdk";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { resolveTeam, type TeamLinear } from "../../orchestration/teams.ts";

const logger = getLogger("ops-triage:linear");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LinearAccount {
  apiKey: string;
  teamId: string;
}

// Process-lifetime warn dedup: an unset apiKeyEnv is a static config mismatch, not a per-call
// condition, so a caller hitting resolveLinearAccount repeatedly must not spam identical warnings.
const warnedUnsetEnv = new Set<string>();

/** Test-only: clears the warn-once cache between cases that reuse the same team id. */
export function __resetLinearWarnDedup(): void {
  warnedUnsetEnv.clear();
}

/** `linear.apiKeyEnv` names the env var to read for this team's key. Unset/empty → the team's
 *  Linear is treated as fully unconfigured (falls through to the default account, same as when
 *  `linear` is absent). Absent entirely → no key, same fallthrough. */
function resolveApiKey(teamId: string, linear: TeamLinear): string | undefined {
  if (!linear.apiKeyEnv) return undefined;
  const fromEnv = process.env[linear.apiKeyEnv];
  if (fromEnv) return fromEnv;
  if (!warnedUnsetEnv.has(teamId)) {
    warnedUnsetEnv.add(teamId);
    logger.warn(
      { teamId, apiKeyEnv: linear.apiKeyEnv },
      "team's linear.apiKeyEnv names an unset/empty env var — falling back to the default Linear account",
    );
  }
  return undefined;
}

/** Pure account resolution (offline, no network). The space's team wins with its own Linear;
 *  a team without `linear`, or a space in no team, falls through to the default (SUSHI).
 *  Never throws — an absent account surfaces only when a call actually needs credentials. */
export function resolveLinearAccount(surface: string, spaceId: string): LinearAccount {
  const team = resolveTeam(surface, spaceId);
  const own = team?.linear;
  if (own) {
    const apiKey = resolveApiKey(team!.id, own);
    if (apiKey) return { apiKey, teamId: own.teamId };
  }
  return { apiKey: config.linearApiKey ?? "", teamId: config.linearTeamId ?? "" };
}

/** Accepts a bare identifier ("ENG-123"), a UUID, or a full issue URL. */
function extractIssueId(raw: string): string {
  const match = raw.match(/([A-Z][A-Z0-9]*-\d+)/);
  return match ? match[1] : raw;
}

/** All Linear operations bound to ONE resolved account. Instances are cached per account
 *  (apiKey+teamId), so each account keeps its OWN team-id resolution — no cross-account bleed. */
class ScopedLinear {
  private teamIdPromise?: Promise<string>;

  constructor(
    private readonly client: LinearClient,
    private readonly account: LinearAccount,
  ) {}

  /** LINEAR_TEAM_ID may be the team's UUID or its short key (e.g. "SUSHI") — resolved once per
   *  account and cached on the instance. */
  private requireTeamId(): Promise<string> {
    if (!this.account.teamId) return Promise.reject(new Error("LINEAR_TEAM_ID is not configured."));
    if (UUID_RE.test(this.account.teamId)) return Promise.resolve(this.account.teamId);
    this.teamIdPromise ??= (async () => {
      const result = await this.client.teams({ filter: { key: { eq: this.account.teamId } }, first: 1 });
      const team = result.nodes[0];
      if (!team) throw new Error(`No Linear team found with key "${this.account.teamId}".`);
      return team.id;
    })();
    return this.teamIdPromise;
  }

  /** Finds a team-scoped label by name, creating it if it doesn't exist yet. */
  private async resolveLabelId(name: string): Promise<string> {
    const teamId = await this.requireTeamId();
    const existing = await this.client.issueLabels({
      filter: { name: { eq: name }, team: { id: { eq: teamId } } },
      first: 1,
    });
    if (existing.nodes[0]) return existing.nodes[0].id;

    const created = await this.client.createIssueLabel({ name, teamId });
    const label = await created.issueLabel;
    if (!label) throw new Error(`Failed to create Linear label "${name}"`);
    return label.id;
  }

  async createTriageIssue(title: string, description: string, repoLabel: string): Promise<Issue> {
    const teamId = await this.requireTeamId();
    const labelId = await this.resolveLabelId(repoLabel);
    const payload = await this.client.createIssue({ teamId, title, description, labelIds: [labelId] });
    const issue = await payload.issue;
    if (!issue) throw new Error("Linear did not return the created issue.");
    return issue;
  }

  async fetchIssueStatus(rawId: string) {
    const issue = await this.client.issue(extractIssueId(rawId));
    const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
    return {
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: state?.name ?? "(no state)",
      assignee: assignee?.name ?? "(unassigned)",
      updatedAt: issue.updatedAt,
    };
  }

  async listTriageIssues(repoLabel: string | undefined, state: string | undefined) {
    const teamId = await this.requireTeamId();
    const filter: LinearDocument.IssueFilter = { team: { id: { eq: teamId } } };
    // `some`, not `every` -- an issue with more than one label (any teammate adding a priority
    // tag, "bug", etc. after filing is ordinary Linear usage) must still match on repoLabel alone.
    if (repoLabel) filter.labels = { some: { name: { eq: repoLabel } } };
    if (state) filter.state = { name: { eq: state } };

    const result = await this.client.issues({ filter, first: 25, orderBy: LinearDocument.PaginationOrderBy.UpdatedAt });
    return Promise.all(
      result.nodes.map(async (issue) => ({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: (await issue.state)?.name ?? "(no state)",
      })),
    );
  }
}

function accountKey(a: LinearAccount): string {
  return `${a.apiKey}\n${a.teamId}`;
}

// Cached per account (apiKey+teamId), NOT a single module global — a per-account instance carries its
// own client AND its own resolved team id, so two teams never share an account.
const scopedCache = new Map<string, ScopedLinear>();

/** Resolve the Linear client bound to the account for (surface, spaceId). Throws only when NEITHER
 *  the space's team NOR the default has an API key configured. */
export function linearFor(surface: string, spaceId: string): ScopedLinear {
  const account = resolveLinearAccount(surface, spaceId);
  if (!account.apiKey) throw new Error("LINEAR_API_KEY is not configured.");
  const key = accountKey(account);
  let scoped = scopedCache.get(key);
  if (!scoped) {
    scoped = new ScopedLinear(new LinearClient({ apiKey: account.apiKey }), account);
    scopedCache.set(key, scoped);
  }
  return scoped;
}
