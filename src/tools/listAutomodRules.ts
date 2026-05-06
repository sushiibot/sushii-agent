import type { Client } from "discord.js";
import { AutoModerationRuleTriggerType, AutoModerationActionType } from "discord-api-types/v10";

export interface AutomodActionInfo {
  type: "block_message" | "send_alert_message" | "timeout" | "block_member_interaction" | "unknown";
  channelId?: string;
  durationSeconds?: number;
  customMessage?: string;
}

export interface AutomodRuleInfo {
  id: string;
  name: string;
  triggerType: string;
  enabled: boolean;
  keywordFilter: string[];
  regexPatterns: string[];
  allowList: string[];
  actions: AutomodActionInfo[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
}

function triggerTypeName(t: number): string {
  switch (t) {
    case AutoModerationRuleTriggerType.Keyword: return "KEYWORD";
    case AutoModerationRuleTriggerType.Spam: return "SPAM";
    case AutoModerationRuleTriggerType.KeywordPreset: return "KEYWORD_PRESET";
    case AutoModerationRuleTriggerType.MentionSpam: return "MENTION_SPAM";
    case AutoModerationRuleTriggerType.MemberProfile: return "MEMBER_PROFILE";
    default: return `UNKNOWN(${t})`;
  }
}

function actionTypeName(t: number): AutomodActionInfo["type"] {
  switch (t) {
    case AutoModerationActionType.BlockMessage: return "block_message";
    case AutoModerationActionType.SendAlertMessage: return "send_alert_message";
    case AutoModerationActionType.Timeout: return "timeout";
    case AutoModerationActionType.BlockMemberInteraction: return "block_member_interaction";
    default: return "unknown";
  }
}

export async function listAutomodRules({
  guildId,
  client,
}: {
  guildId: string;
  client: Client<true>;
}): Promise<AutomodRuleInfo[] | { error: string }> {
  try {
    const guild = await client.guilds.fetch(guildId);
    const rules = await guild.autoModerationRules.fetch();

    return [...rules.values()].map((rule) => {
      const actions: AutomodActionInfo[] = [...rule.actions.values()].map((action) => {
        const info: AutomodActionInfo = { type: actionTypeName(action.type) };
        if (action.metadata.channelId) info.channelId = action.metadata.channelId;
        if (action.metadata.durationSeconds != null) info.durationSeconds = action.metadata.durationSeconds;
        if (action.metadata.customMessage) info.customMessage = action.metadata.customMessage;
        return info;
      });

      const exemptRoleIds = [...rule.exemptRoles.keys()];
      const exemptChannelIds = [...rule.exemptChannels.keys()];

      return {
        id: rule.id,
        name: rule.name,
        triggerType: triggerTypeName(rule.triggerType),
        enabled: rule.enabled,
        keywordFilter: [...(rule.triggerMetadata.keywordFilter ?? [])],
        regexPatterns: [...(rule.triggerMetadata.regexPatterns ?? [])],
        allowList: [...(rule.triggerMetadata.allowList ?? [])],
        actions,
        exemptRoleIds,
        exemptChannelIds,
      };
    });
  } catch (err) {
    return { error: `Failed to fetch automod rules: ${err}` };
  }
}
