import { LinearClient, LinearDocument, type Issue } from "@linear/sdk";
import { config } from "../../config.ts";
import { resolveCommunity } from "../../orchestration/communities.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LinearAccount {
  apiKey: string;
  teamId: string;
}

/** Pure account resolution (offline, no network). The space's community wins with its own Linear;
 *  a community without `linear`, or a space in no community, falls through to the default (SUSHI).
 *  Never throws — an absent account surfaces only when a call actually needs credentials. */
export function resolveLinearAccount(surface: string, spaceId: string): LinearAccount {
  const own = resolveCommunity(surface, spaceId)?.linear;
  if (own) return own;
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
// own client AND its own resolved team id, so two communities never share a team.
const scopedCache = new Map<string, ScopedLinear>();

/** Resolve the Linear client bound to the account for (surface, spaceId). Throws only when NEITHER
 *  the space's community NOR the default has an API key configured. */
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
