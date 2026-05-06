import type { Client } from "discord.js";
import { AutoModerationRuleTriggerType } from "discord-api-types/v10";

export interface AutomodRuleData {
  ruleId: string;
  ruleName: string;
  keywordFilter: string[];
  regexPatterns: string[];
  allowList: string[];
}

const SUPPORTED_TRIGGER_TYPES = [
  AutoModerationRuleTriggerType.Keyword,
  AutoModerationRuleTriggerType.MemberProfile,
];

/**
 * Fetch an automod rule and extract its mutable metadata.
 * Returns an error object if the rule is not found, the bot lacks permissions,
 * or the trigger type doesn't support keyword_filter.
 * Uses force: true to bypass the discord.js cache.
 */
export async function fetchAutomodRule({
  guildId,
  ruleId,
  client,
}: {
  guildId: string;
  ruleId: string;
  client: Client<true>;
}): Promise<AutomodRuleData | { error: string }> {
  try {
    const guild = await client.guilds.fetch(guildId);

    let rule;
    try {
      rule = await guild.autoModerationRules.fetch({ autoModerationRule: ruleId, force: true });
    } catch {
      return { error: `Rule ${ruleId} not found or bot lacks MANAGE_GUILD permission.` };
    }

    if (!SUPPORTED_TRIGGER_TYPES.includes(rule.triggerType as AutoModerationRuleTriggerType)) {
      return {
        error: `Rule "${rule.name}" has trigger type ${rule.triggerType} which does not support keyword_filter. Only KEYWORD and MEMBER_PROFILE rules support this.`,
      };
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      keywordFilter: [...(rule.triggerMetadata.keywordFilter ?? [])],
      regexPatterns: [...(rule.triggerMetadata.regexPatterns ?? [])],
      allowList: [...(rule.triggerMetadata.allowList ?? [])],
    };
  } catch (err) {
    return { error: `Failed to fetch automod rule: ${err}` };
  }
}
