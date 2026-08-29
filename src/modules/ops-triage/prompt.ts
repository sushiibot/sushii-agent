import { config } from "../../config.ts";

/**
 * Appended to the system prompt only when the triggering user is the configured owner (see
 * loop.ts's buildSystemPrompt) — everyone else gets no mention of these tools at all, since
 * they can't call them anyway (see executor.ts's requireOwner). Without this, the bot's base
 * identity is moderation-focused (BEHAVIOR_INSTRUCTIONS) and nothing tells the model these
 * unrelated ops tools exist or when to reach for them.
 */
export function buildOpsTriagePromptSection(): string | undefined {
  const hasGrafana = !!config.grafanaBaseUrl;
  const hasLinear = !!(config.linearApiKey && config.linearTeamId);
  if (!hasGrafana && !hasLinear) return undefined;

  const lines = [
    "## Ops Tools (owner-only)",
    "You are talking to your owner, who can also ask you to diagnose and track bugs across sushii's Discord bots (sushii-bot, sushii-agent, sushii-sns, sushii-modmail, sushii-leveling-bot) — this is unrelated to server moderation, don't let it change how you talk about this server.",
  ];
  if (hasGrafana) {
    lines.push("- search_logs / get_trace: look up logs and traces for a service around a time range. If diagnosing a specific reported message, use its t:<unix>:R timestamp from the conversation (pad +/- a few minutes) rather than guessing a range.");
  }
  if (hasLinear) {
    lines.push("- file_linear_issue / get_issue_status / list_triaged_issues: file a bug/improvement as a Linear issue (labeled by repo) for a separate implementation agent to pick up later, or check on one already filed. Only file an issue once you've actually diagnosed something concrete — don't file speculative issues from a vague report alone.");
  }
  return lines.join("\n");
}
