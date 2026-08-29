import { LinearClient, LinearDocument, type Issue } from "@linear/sdk";
import { config } from "../../config.ts";

let client: LinearClient | undefined;

export function getLinearClient(): LinearClient {
  if (!config.linearApiKey) throw new Error("LINEAR_API_KEY is not configured.");
  client ??= new LinearClient({ apiKey: config.linearApiKey });
  return client;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let resolvedTeamId: string | undefined;

/** LINEAR_TEAM_ID may be either the team's UUID or its short key (e.g. "SUSHI", from linear.app/<org>/team/<key>/...) — resolved once and cached. */
async function requireTeamId(): Promise<string> {
  if (!config.linearTeamId) throw new Error("LINEAR_TEAM_ID is not configured.");
  if (UUID_RE.test(config.linearTeamId)) return config.linearTeamId;
  if (resolvedTeamId) return resolvedTeamId;

  const linear = getLinearClient();
  const result = await linear.teams({ filter: { key: { eq: config.linearTeamId } }, first: 1 });
  const team = result.nodes[0];
  if (!team) throw new Error(`No Linear team found with key "${config.linearTeamId}".`);
  resolvedTeamId = team.id;
  return team.id;
}

/** Finds a team-scoped label by name, creating it if it doesn't exist yet. */
async function resolveLabelId(name: string): Promise<string> {
  const teamId = await requireTeamId();
  const linear = getLinearClient();
  const existing = await linear.issueLabels({
    filter: { name: { eq: name }, team: { id: { eq: teamId } } },
    first: 1,
  });
  if (existing.nodes[0]) return existing.nodes[0].id;

  const created = await linear.createIssueLabel({ name, teamId });
  const label = await created.issueLabel;
  if (!label) throw new Error(`Failed to create Linear label "${name}"`);
  return label.id;
}

/** Accepts a bare identifier ("ENG-123"), a UUID, or a full issue URL. */
function extractIssueId(raw: string): string {
  const match = raw.match(/([A-Z][A-Z0-9]*-\d+)/);
  return match ? match[1] : raw;
}

export async function createTriageIssue(title: string, description: string, repoLabel: string): Promise<Issue> {
  const teamId = await requireTeamId();
  const linear = getLinearClient();
  const labelId = await resolveLabelId(repoLabel);
  const payload = await linear.createIssue({ teamId, title, description, labelIds: [labelId] });
  const issue = await payload.issue;
  if (!issue) throw new Error("Linear did not return the created issue.");
  return issue;
}

export async function fetchIssueStatus(rawId: string) {
  const linear = getLinearClient();
  const issue = await linear.issue(extractIssueId(rawId));
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

export async function listTriageIssues(repoLabel: string | undefined, state: string | undefined) {
  const teamId = await requireTeamId();
  const linear = getLinearClient();
  const filter: LinearDocument.IssueFilter = { team: { id: { eq: teamId } } };
  // `some`, not `every` -- an issue with more than one label (any teammate adding a priority
  // tag, "bug", etc. after filing is ordinary Linear usage) must still match on repoLabel alone.
  if (repoLabel) filter.labels = { some: { name: { eq: repoLabel } } };
  if (state) filter.state = { name: { eq: state } };

  const result = await linear.issues({ filter, first: 25, orderBy: LinearDocument.PaginationOrderBy.UpdatedAt });
  const withState = await Promise.all(
    result.nodes.map(async (issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: (await issue.state)?.name ?? "(no state)",
    })),
  );
  return withState;
}
