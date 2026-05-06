import type { Client } from "discord.js";
import { AutoModerationRuleTriggerType } from "discord-api-types/v10";

export interface PendingAutomodApproval {
  ruleId: string;
  ruleName: string;
  keyword: string;
  /** Full updated keyword_filter array (existing + new keyword) to PATCH with */
  newKeywordFilter: string[];
  /** Preserved as-is for the PATCH — omitting would wipe them */
  regexPatterns: string[];
  allowList: string[];
}

export async function addAutomodKeyword({
  guildId,
  ruleId,
  keyword,
  client,
}: {
  guildId: string;
  ruleId: string;
  keyword: string;
  client: Client<true>;
}): Promise<PendingAutomodApproval | { error: string }> {
  if (keyword.length > 60) {
    return { error: `Keyword too long (${keyword.length} chars, max 60).` };
  }

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

    if (currentFilter.length >= 1000) {
      return { error: `Rule "${rule.name}" is at the 1000-keyword limit. Remove existing keywords before adding new ones.` };
    }

    const normalizedNew = keyword.toLowerCase();
    const duplicate = currentFilter.find((k) => k.toLowerCase() === normalizedNew);
    if (duplicate) {
      return { error: `Keyword "${duplicate}" is already in rule "${rule.name}".` };
    }

    const newKeywordFilter = [...currentFilter, keyword];

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      keyword,
      newKeywordFilter,
      regexPatterns,
      allowList,
    };
  } catch (err) {
    return { error: `Failed to prepare automod keyword addition: ${err}` };
  }
}
