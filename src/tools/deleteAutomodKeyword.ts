import type { Client } from "discord.js";
import { fetchAutomodRule } from "./automodUtils.ts";

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
  const ruleData = await fetchAutomodRule({ guildId, ruleId, client });
  if ("error" in ruleData) return ruleData;

  const { ruleName, keywordFilter, regexPatterns, allowList } = ruleData;

  const normalizedTarget = keyword.toLowerCase();
  const existing = keywordFilter.find((k) => k.toLowerCase() === normalizedTarget);
  if (!existing) {
    return { error: `Keyword "${keyword}" was not found in rule "${ruleName}". Use list_automod_rules to see current keywords.` };
  }

  const newKeywordFilter = keywordFilter.filter((k) => k !== existing);

  return {
    ruleId: ruleData.ruleId,
    ruleName,
    keyword: existing, // use the exact casing from the rule
    newKeywordFilter,
    regexPatterns,
    allowList,
  };
}
