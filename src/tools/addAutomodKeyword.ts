import type { Client } from "discord.js";
import { fetchAutomodRule } from "./automodUtils.ts";

export interface PendingAutomodApproval {
  ruleId: string;
  ruleName: string;
  keyword: string;
  /** keyword_filter after addition — what will be PATCHed on approval */
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
    return { error: `Keyword "${keyword}" exceeds the 60-character Discord limit.` };
  }

  const ruleData = await fetchAutomodRule({ guildId, ruleId, client });
  if ("error" in ruleData) return ruleData;

  const { ruleName, keywordFilter, regexPatterns, allowList } = ruleData;

  const normalizedKeyword = keyword.toLowerCase();
  if (keywordFilter.some((k) => k.toLowerCase() === normalizedKeyword)) {
    return { error: `Keyword "${keyword}" is already in rule "${ruleName}". No change made.` };
  }

  if (keywordFilter.length >= 1000) {
    return { error: `Rule "${ruleName}" already has 1000 keywords, which is the Discord limit. Remove some before adding more.` };
  }

  return {
    ruleId: ruleData.ruleId,
    ruleName,
    keyword,
    newKeywordFilter: [...keywordFilter, keyword],
    regexPatterns,
    allowList,
  };
}
