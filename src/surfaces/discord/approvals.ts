import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Client,
  type ThreadChannel,
} from "discord.js";
import type { ApprovalRequest } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { buildTextDisplayContainer } from "./delivery.ts";
import { AUTOMOD_BTN_PREFIX, AUTOMOD_DEL_BTN_PREFIX, SCAN_BTN_PREFIX } from "./buttonIds.ts";

const logger = getLogger("surfaces/discord/approvals");

export const SCAN_QUERY =
  "[System: Perform initial server scan. Use listGuildChannels, listGuildRoles, and getRecentActivity to gather information about this server's structure and recent activity. Then call updateServerContext with a concise summary covering channels, roles, and any notable patterns. Identify the channel that holds the server rules and record only its channel ID — never the rule text itself, which can change independently. This is a background initialization task — do not address the user directly.]";

/** Alphabetical neighbor context for an automod keyword. Ported verbatim from the old
 *  moderation/interactions.ts. `existingKeywords` is the pre-add list (mode "add") or the
 *  post-remove list (mode "remove"); the keyword is (re-)inserted at its sorted position. */
function buildNeighborContext(existingKeywords: string[], keyword: string, opts?: { windowSize?: number; mode?: "add" | "remove" }): string {
  const windowSize = opts?.windowSize ?? 5;
  const isRemoval = opts?.mode === "remove";
  const sortKey = (k: string) => k.replace(/^\*+/, "").replace(/\*+$/, "").toLowerCase();
  const sorted = [...existingKeywords].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const insertIdx = sorted.findIndex((k) => sortKey(k) > sortKey(keyword));
  const insertAt = insertIdx === -1 ? sorted.length : insertIdx;
  const withKeyword = [...sorted.slice(0, insertAt), keyword, ...sorted.slice(insertAt)];
  const start = Math.max(0, insertAt - windowSize);
  const end = Math.min(withKeyword.length, insertAt + windowSize + 1);
  const neighbors = withKeyword.slice(start, end);
  const lines: string[] = [];
  if (start > 0) lines.push("...");
  for (let i = 0; i < neighbors.length; i++) {
    const k = neighbors[i];
    if (start + i === insertAt) lines.push(isRemoval ? `- ${k}` : `+ ${k}`);
    else lines.push(`  ${k}`);
  }
  if (end < withKeyword.length) lines.push("...");
  return `\`\`\`diff\n${lines.join("\n")}\n\`\`\``;
}

/** Builds the 🔒 automod approval prompt (rich neighbor diff + counts + approve/reject buttons),
 *  matching the old sendAutomodApprovalMessage/sendAutomodDeletionMessage rendering. */
export function buildApprovalContainer(threadId: string, payload: ApprovalRequest): ContainerBuilder {
  const add = payload.action === "automod-keyword-add";
  const { ruleName = "", ruleId = "", keyword = "", keywordFilterAfter = [] } = payload.platform;
  const oldCount = add ? keywordFilterAfter.length - 1 : keywordFilterAfter.length + 1;
  const newCount = keywordFilterAfter.length;
  const neighborStr = add
    ? buildNeighborContext(keywordFilterAfter.filter((k) => k !== keyword), keyword)
    : buildNeighborContext(keywordFilterAfter, keyword, { mode: "remove" });

  const title = add
    ? "🔒 **Automod keyword addition — awaiting approval**"
    : "🔒 **Automod keyword removal — awaiting approval**";
  const actionLabel = add ? "Keyword to add" : "Keyword to remove";
  const bodyLines = [
    `**Rule:** ${ruleName} (\`${ruleId}\`)`,
    `**${actionLabel}:** \`${keyword}\``,
    `**Keywords:** ${oldCount} → ${newCount}`,
    "",
    "Nearby keywords in rule:",
    neighborStr,
  ];
  const btnPrefix = add ? AUTOMOD_BTN_PREFIX : AUTOMOD_DEL_BTN_PREFIX;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${btnPrefix}${threadId}:approve`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${btnPrefix}${threadId}:reject`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
  );
  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `${title}\n\n${bodyLines.join("\n")}` }))
    .addActionRowComponents(row);
}

export async function setAutomodStatus(interaction: ButtonInteraction, label: string): Promise<void> {
  try {
    await interaction.editReply({ components: [buildTextDisplayContainer(`-# ${label}`)], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical.
  }
}

export interface AutomodApplyResult {
  systemMessage: string;
}

/** Applies (or rejects) an approved automod keyword change and edits the button message with the
 *  outcome. Re-fetches the rule live so a concurrent edit is not clobbered — ported from the old
 *  handleAutomod{Approval,Deletion}Button. Returns the system message to resume the agent with. */
export async function applyAutomodDecision(
  interaction: ButtonInteraction,
  client: Client<true>,
  action: "automod-keyword-add" | "automod-keyword-delete",
  ruleId: string,
  ruleName: string,
  keyword: string,
  decision: "approve" | "reject",
): Promise<AutomodApplyResult> {
  const add = action === "automod-keyword-add";
  if (decision !== "approve") {
    await setAutomodStatus(interaction, add ? `❌ Rejected — \`${keyword}\` not added to "${ruleName}"` : `❌ Rejected — \`${keyword}\` kept in "${ruleName}"`);
    return { systemMessage: add
      ? `[System: Moderator rejected the keyword addition. "${keyword}" was NOT added to rule "${ruleName}".]`
      : `[System: Moderator rejected the keyword removal. "${keyword}" was NOT removed from rule "${ruleName}".]` };
  }

  try {
    const guild = await client.guilds.fetch(interaction.guildId!);
    const currentRule = await guild.autoModerationRules.fetch({ autoModerationRule: ruleId, force: true });
    const currentFilter = [...(currentRule.triggerMetadata.keywordFilter ?? [])];
    const currentRegex = [...(currentRule.triggerMetadata.regexPatterns ?? [])];
    const currentAllow = [...(currentRule.triggerMetadata.allowList ?? [])];

    if (add) {
      if (currentFilter.some((k) => k.toLowerCase() === keyword.toLowerCase())) {
        await setAutomodStatus(interaction, `⚠️ Already exists — \`${keyword}\` was already in "${ruleName}" (added by someone else). No changes made.`);
        return { systemMessage: `[System: Moderator approved, but "${keyword}" is already in rule "${ruleName}" (added by someone else in the meantime). No changes made.]` };
      }
      await guild.autoModerationRules.edit(ruleId, {
        triggerMetadata: { keywordFilter: [...currentFilter, keyword], regexPatterns: currentRegex, allowList: currentAllow },
        reason: `Added keyword "${keyword}" via sushii-agent (approved by ${interaction.user.username})`,
      });
      const oldCount = currentFilter.length;
      const newCount = oldCount + 1;
      await setAutomodStatus(interaction, `✅ Added \`${keyword}\` to "${ruleName}" (${oldCount} → ${newCount} keywords)`);
      logger.info({ ruleId, keyword, guildId: interaction.guildId }, "automod keyword added");
      return { systemMessage: `[System: Moderator approved. Keyword "${keyword}" was successfully added to automod rule "${ruleName}" (${oldCount} → ${newCount} keywords). The rule is now live.]` };
    }

    const existingIdx = currentFilter.findIndex((k) => k.toLowerCase() === keyword.toLowerCase());
    if (existingIdx === -1) {
      await setAutomodStatus(interaction, `⚠️ Already removed — \`${keyword}\` was already gone from "${ruleName}" (removed by someone else). No changes made.`);
      return { systemMessage: `[System: Moderator approved, but "${keyword}" is no longer in rule "${ruleName}" (already removed by someone else in the meantime). No changes made.]` };
    }
    const newFilter = currentFilter.filter((_, i) => i !== existingIdx);
    await guild.autoModerationRules.edit(ruleId, {
      triggerMetadata: { keywordFilter: newFilter, regexPatterns: currentRegex, allowList: currentAllow },
      reason: `Removed keyword "${keyword}" via sushii-agent (approved by ${interaction.user.username})`,
    });
    const oldCount = currentFilter.length;
    const newCount = newFilter.length;
    await setAutomodStatus(interaction, `✅ Removed \`${keyword}\` from "${ruleName}" (${oldCount} → ${newCount} keywords)`);
    logger.info({ ruleId, keyword, guildId: interaction.guildId }, "automod keyword removed");
    return { systemMessage: `[System: Moderator approved. Keyword "${keyword}" was successfully removed from automod rule "${ruleName}" (${oldCount} → ${newCount} keywords). The rule is now live.]` };
  } catch (err) {
    await setAutomodStatus(interaction, add ? `❌ Failed to add \`${keyword}\` to "${ruleName}" — Discord API error` : `❌ Failed to remove \`${keyword}\` from "${ruleName}" — Discord API error`);
    logger.error({ err, ruleId, keyword }, "automod edit failed");
    return { systemMessage: `[System: Moderator approved, but the Discord API call failed: ${err}. The keyword was NOT ${add ? "added" : "removed"}. You may try again.]` };
  }
}

// ── Server scan approval ───────────────────────────────────────────────────────

export async function sendScanApprovalMessage(thread: ThreadChannel, guildId: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${SCAN_BTN_PREFIX}${guildId}:yes`).setLabel("Scan server").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${SCAN_BTN_PREFIX}${guildId}:no`).setLabel("Skip").setStyle(ButtonStyle.Secondary),
  );
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: "No server context found. Would you like me to scan the server first (channels, roles, recent activity) before handling your request?" }))
    .addActionRowComponents(row);
  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

export async function disableScanButtons(interaction: ButtonInteraction, selectedLabel: string): Promise<void> {
  try {
    await interaction.editReply({ components: [buildTextDisplayContainer(`-# Selected: ${selectedLabel}`)], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical.
  }
}
