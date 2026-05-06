import type { Client } from "discord.js";
import { AutoModerationRuleTriggerType } from "discord-api-types/v10";

export interface PendingAutomodDeletion {
  ruleId: string;
  ruleName: string;
  /** The exact string as it appears in the keyword_filter (may differ in casing from what the LLM passed) */
  keyword: string;
  /** keyword_filter after removal — what will be PATCHed on approval */
  newKeywordFilter: string[];
  /** Preserved as-is for the PATCH — omitting would wipe them */
  regexPatterns: string[];
  allowList: string[];
}

export async function deleteAutomodKeyword({
  guildId,
  ruleId,
  keyword,
  client,
}: {
  guildId: string;
  ruleId: string;
  keyword: string;
  client: Client<true>;
}): Promise<PendingAutomodDeletion | { error: string }> {
  try {
    const guild = await client.guilds.fetch(guildId);

    let rule;
    try {
      rule = await guild.autoModerationRules.fetch({ autoModerationRule: ruleId, force: true });
    } catch {
      return { error: `Rule ${ruleId} not found or bot lacks MANAGE_GUILD permission.` };
    }

    const supportedTypes = [
      AutoModerationRuleTriggerType.Keyword,
      AutoModerationRuleTriggerType.MemberProfile,
    ];
    if (!supportedTypes.includes(rule.triggerType as AutoModerationRuleTriggerType)) {
      return { error: `Rule "${rule.name}" has trigger type ${rule.triggerType} which does not support keyword_filter. Only KEYWORD and MEMBER_PROFILE rules support this.` };
    }

    const currentFilter = [...(rule.triggerMetadata.keywordFilter ?? [])];
    const regexPatterns = [...(rule.triggerMetadata.regexPatterns ?? [])];
    const allowList = [...(rule.triggerMetadata.allowList ?? [])];

    const normalizedTarget = keyword.toLowerCase();
    const existing = currentFilter.find((k) => k.toLowerCase() === normalizedTarget);
    if (!existing) {
      return { error: `Keyword "${keyword}" was not found in rule "${rule.name}". Use list_automod_rules to see current keywords.` };
    }

    const newKeywordFilter = currentFilter.filter((k) => k !== existing);

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      keyword: existing, // use the exact casing from the rule
      newKeywordFilter,
      regexPatterns,
      allowList,
    };
  } catch (err) {
    return { error: `Failed to prepare automod keyword deletion: ${err}` };
  }
}
