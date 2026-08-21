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
import type { Span } from "@opentelemetry/api";
import { client } from "../../discordClient.ts";
import { getLogger } from "../../logger.ts";
import { config, buildEmojiMap, resolvedModules } from "../../config.ts";
import { getServerContext, listMemoryTitles, getMemoryCount, MEMORY_LIMIT } from "../../db/memory.ts";
import {
  buildTextDisplayContainer,
  ToolProgressTracker,
  withThreadLock,
  cleanupAgentRun,
  threadCancellations,
  threadTriggeringUsers,
  buildComponentMessages,
} from "../../agent/delivery.ts";
import {
  runAgentLoop,
  type AgentLoopResult,
  type AgentLoopOptions,
  type ChannelContext,
  type TriggeringUser,
  type UserNames,
  type AutoModTriggerContext,
} from "../../agent/loop.ts";
import { BEHAVIOR_INSTRUCTIONS } from "./prompt.ts";
import type { PendingAutomodApproval, PendingAutomodDeletion } from "./executor.ts";
import { pendingAutomodApprovals, pendingAutomodDeletions, pendingScans } from "./state.ts";

const logger = getLogger("moderation/interactions");

// Custom ID prefix for initial server scan approval buttons
export const SCAN_BTN_PREFIX = "srv:";
// Custom ID prefix for automod keyword add approval buttons: amka:{threadId}:{approve|reject}
export const AUTOMOD_BTN_PREFIX = "amka:";
// Custom ID prefix for automod keyword delete approval buttons: amkd:{threadId}:{approve|reject}
export const AUTOMOD_DEL_BTN_PREFIX = "amkd:";

type BuildLoopOptionsFn = (
  thread: ThreadChannel,
  guildId: string,
  emojiMap: Record<string, string>,
  toolTracker: ToolProgressTracker,
  opts: {
    threadContext?: string;
    mentionedUsers?: Map<string, UserNames>;
    triggeringUser?: TriggeringUser;
    currentChannel?: ChannelContext;
    serverContext: string | null;
    memoryIndex: string[];
    memoryCount: number;
    autoModTrigger?: AutoModTriggerContext;
  },
) => AgentLoopOptions;

type HandleAgentResultFn = (
  thread: ThreadChannel,
  guildId: string,
  threadId: string,
  agentResult: AgentLoopResult,
  threadContext: string | null,
  triggeredByUserId: string,
) => Promise<void>;

type WithInteractionSpanFn = <T>(
  name: string,
  attributes: Record<string, string | undefined>,
  fn: (span: Span) => Promise<T>,
) => Promise<T>;

/**
 * Builds an alphabetical neighbor context string for an automod keyword.
 *
 * For additions (mode="add"): `existingKeywords` is the pre-addition list.
 * The new keyword is inserted at its sorted position and marked with arrows.
 *
 * For removals (mode="remove"): `existingKeywords` is the post-removal list
 * (the keyword has already been removed). The keyword is temporarily re-inserted
 * at its sorted position and marked with strikethrough, so the moderator can see
 * exactly where it sat among its neighbors.
 */
function buildNeighborContext(
  existingKeywords: string[],
  keyword: string,
  opts?: { windowSize?: number; mode?: "add" | "remove" },
): string {
  const windowSize = opts?.windowSize ?? 5;
  const isRemoval = opts?.mode === "remove";
  const sortKey = (k: string) => k.replace(/^\*+/, "").replace(/\*+$/, "").toLowerCase();
  const sorted = [...existingKeywords].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  // Find where the keyword sits (or would sit) in sorted order
  const insertIdx = sorted.findIndex(k => sortKey(k) > sortKey(keyword));
  const insertAt = insertIdx === -1 ? sorted.length : insertIdx;
  // For removals, temporarily re-insert the keyword at its sorted position for display
  const withKeyword = [...sorted.slice(0, insertAt), keyword, ...sorted.slice(insertAt)];
  const start = Math.max(0, insertAt - windowSize);
  const end = Math.min(withKeyword.length, insertAt + windowSize + 1);
  const neighbors = withKeyword.slice(start, end);
  const lines: string[] = [];
  if (start > 0) lines.push("...");
  for (let i = 0; i < neighbors.length; i++) {
    const k = neighbors[i];
    if (start + i === insertAt) {
      lines.push(isRemoval ? `- ${k}` : `+ ${k}`);
    } else {
      lines.push(`  ${k}`);
    }
  }
  if (end < withKeyword.length) lines.push("...");
  return `\`\`\`diff\n${lines.join("\n")}\n\`\`\``;
}

export async function sendAutomodActionMessage(
  thread: ThreadChannel,
  params: {
    mode: "add" | "remove";
    btnPrefix: string;
    ruleName: string;
    ruleId: string;
    keyword: string;
    oldCount: number;
    newCount: number;
    neighborStr: string;
  },
): Promise<void> {
  const threadId = thread.id;
  const { mode, btnPrefix, ruleName, ruleId, keyword, oldCount, newCount, neighborStr } = params;
  const title = mode === "add"
    ? "🔒 **Automod keyword addition — awaiting approval**"
    : "🔒 **Automod keyword removal — awaiting approval**";
  const actionLabel = mode === "add" ? "Keyword to add" : "Keyword to remove";

  const bodyLines = [
    `**Rule:** ${ruleName} (\`${ruleId}\`)`,
    `**${actionLabel}:** \`${keyword}\``,
    `**Keywords:** ${oldCount} → ${newCount}`,
    "",
    `Nearby keywords in rule:`,
    neighborStr,
  ];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${btnPrefix}${threadId}:approve`)
      .setLabel("✅ Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${btnPrefix}${threadId}:reject`)
      .setLabel("❌ Reject")
      .setStyle(ButtonStyle.Danger),
  );

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `${title}\n\n${bodyLines.join("\n")}` }))
    .addActionRowComponents(row);

  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

export async function sendAutomodApprovalMessage(thread: ThreadChannel, approval: PendingAutomodApproval): Promise<void> {
  // PendingAutomodApproval.newKeywordFilter already includes the new keyword (post-addition),
  // so oldCount = length - 1 and newCount = length.
  const oldCount = approval.newKeywordFilter.length - 1;
  const newCount = approval.newKeywordFilter.length;
  const existing = approval.newKeywordFilter.filter(k => k !== approval.keyword);
  const neighborStr = buildNeighborContext(existing, approval.keyword);
  await sendAutomodActionMessage(thread, {
    mode: "add",
    btnPrefix: AUTOMOD_BTN_PREFIX,
    ruleName: approval.ruleName,
    ruleId: approval.ruleId,
    keyword: approval.keyword,
    oldCount,
    newCount,
    neighborStr,
  });
}

export async function sendAutomodDeletionMessage(thread: ThreadChannel, deletion: PendingAutomodDeletion): Promise<void> {
  const oldCount = deletion.newKeywordFilter.length + 1;
  const newCount = deletion.newKeywordFilter.length;
  const neighborStr = buildNeighborContext(deletion.newKeywordFilter, deletion.keyword, { mode: "remove" });
  await sendAutomodActionMessage(thread, {
    mode: "remove",
    btnPrefix: AUTOMOD_DEL_BTN_PREFIX,
    ruleName: deletion.ruleName,
    ruleId: deletion.ruleId,
    keyword: deletion.keyword,
    oldCount,
    newCount,
    neighborStr,
  });
}

export async function setAutomodStatus(
  interaction: ButtonInteraction,
  label: string,
): Promise<void> {
  try {
    const container = buildTextDisplayContainer(`-# ${label}`);
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical
  }
}

export async function sendScanApprovalMessage(thread: ThreadChannel, guildId: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SCAN_BTN_PREFIX}${guildId}:yes`)
      .setLabel("Scan server")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${SCAN_BTN_PREFIX}${guildId}:no`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder({ content: "No server context found. Would you like me to scan the server first (channels, roles, recent activity) before handling your request?" }))
    .addActionRowComponents(row);

  await thread.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

async function disableScanButtons(interaction: ButtonInteraction, selectedLabel: string): Promise<void> {
  try {
    const container = buildTextDisplayContainer(`-# Selected: ${selectedLabel}`);
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    // Non-critical
  }
}

/** Handles automod keyword add approval buttons: amka:{threadId}:{approve|reject} */
export async function handleAutomodApprovalButton(
  interaction: ButtonInteraction,
  resumeAgent: (interaction: ButtonInteraction, threadId: string, systemMessage: string) => Promise<void>,
): Promise<void> {
  const rest = interaction.customId.slice(AUTOMOD_BTN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return;
  const threadId = rest.slice(0, lastColon);
  const choice = rest.slice(lastColon + 1); // "approve" | "reject"

  const pending = pendingAutomodApprovals.get(threadId);
  if (!pending) {
    await interaction.reply({ content: "This approval has expired — the bot was restarted. Please re-ask the agent to add the keyword.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== pending.triggeredByUserId) {
    await interaction.reply({
      content: `Only <@${pending.triggeredByUserId}> can respond to this approval.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingAutomodApprovals.delete(threadId);
  await interaction.deferUpdate();
  const btn = interaction;

  try {
    let systemMessage: string;

    if (choice === "approve") {
      try {
        const guild = await client.guilds.fetch(interaction.guildId!);
        // Re-fetch to get current live state — avoid overwriting concurrent changes
        const currentRule = await guild.autoModerationRules.fetch({ autoModerationRule: pending.ruleId, force: true });
        const currentFilter = [...(currentRule.triggerMetadata.keywordFilter ?? [])];
        const currentRegex = [...(currentRule.triggerMetadata.regexPatterns ?? [])];
        const currentAllow = [...(currentRule.triggerMetadata.allowList ?? [])];

        if (currentFilter.some(k => k.toLowerCase() === pending.keyword.toLowerCase())) {
          await setAutomodStatus(btn, `⚠️ Already exists — \`${pending.keyword}\` was already in "${pending.ruleName}" (added by someone else). No changes made.`);
          systemMessage = `[System: Moderator approved, but "${pending.keyword}" is already in rule "${pending.ruleName}" (added by someone else in the meantime). No changes made.]`;
        } else {
          await guild.autoModerationRules.edit(pending.ruleId, {
            triggerMetadata: {
              keywordFilter: [...currentFilter, pending.keyword],
              regexPatterns: currentRegex,
              allowList: currentAllow,
            },
            reason: `Added keyword "${pending.keyword}" via sushii-agent (approved by ${interaction.user.username})`,
          });
          const newCount = currentFilter.length + 1;
          const oldCount = currentFilter.length;
          await setAutomodStatus(btn, `✅ Added \`${pending.keyword}\` to "${pending.ruleName}" (${oldCount} → ${newCount} keywords)`);
          systemMessage = `[System: Moderator approved. Keyword "${pending.keyword}" was successfully added to automod rule "${pending.ruleName}" (${oldCount} → ${newCount} keywords). The rule is now live.]`;
          logger.info({ ruleId: pending.ruleId, keyword: pending.keyword, guildId: interaction.guildId }, "automod keyword added");
        }
      } catch (err) {
        await setAutomodStatus(btn, `❌ Failed to add \`${pending.keyword}\` to "${pending.ruleName}" — Discord API error`);
        systemMessage = `[System: Moderator approved, but the Discord API call failed: ${err}. The keyword was NOT added. You may try again.]`;
        logger.error({ err, ruleId: pending.ruleId, keyword: pending.keyword }, "automod edit failed");
      }
    } else {
      await setAutomodStatus(btn, `❌ Rejected — \`${pending.keyword}\` not added to "${pending.ruleName}"`);
      systemMessage = `[System: Moderator rejected the keyword addition. "${pending.keyword}" was NOT added to rule "${pending.ruleName}".]`;
    }

    await resumeAgent(btn, threadId, systemMessage);
  } catch (err) {
    logger.error({ err }, "Unexpected error in automod approval handler");
  }
}

/** Handles automod keyword deletion approval buttons: amkd:{threadId}:{approve|reject} */
export async function handleAutomodDeletionButton(
  interaction: ButtonInteraction,
  resumeAgent: (interaction: ButtonInteraction, threadId: string, systemMessage: string) => Promise<void>,
): Promise<void> {
  const rest = interaction.customId.slice(AUTOMOD_DEL_BTN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return;
  const threadId = rest.slice(0, lastColon);
  const choice = rest.slice(lastColon + 1); // "approve" | "reject"

  const pending = pendingAutomodDeletions.get(threadId);
  if (!pending) {
    await interaction.reply({ content: "This approval has expired — the bot was restarted. Please re-ask the agent to remove the keyword.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== pending.triggeredByUserId) {
    await interaction.reply({
      content: `Only <@${pending.triggeredByUserId}> can respond to this approval.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingAutomodDeletions.delete(threadId);
  await interaction.deferUpdate();
  const btn = interaction;

  try {
    let systemMessage: string;

    if (choice === "approve") {
      try {
        const guild = await client.guilds.fetch(interaction.guildId!);
        // Re-fetch to get current live state — avoid overwriting concurrent changes
        const currentRule = await guild.autoModerationRules.fetch({ autoModerationRule: pending.ruleId, force: true });
        const currentFilter = [...(currentRule.triggerMetadata.keywordFilter ?? [])];
        const currentRegex = [...(currentRule.triggerMetadata.regexPatterns ?? [])];
        const currentAllow = [...(currentRule.triggerMetadata.allowList ?? [])];

        const existingIdx = currentFilter.findIndex(k => k.toLowerCase() === pending.keyword.toLowerCase());
        if (existingIdx === -1) {
          await setAutomodStatus(btn, `⚠️ Already removed — \`${pending.keyword}\` was already gone from "${pending.ruleName}" (removed by someone else). No changes made.`);
          systemMessage = `[System: Moderator approved, but "${pending.keyword}" is no longer in rule "${pending.ruleName}" (already removed by someone else in the meantime). No changes made.]`;
        } else {
          const newFilter = currentFilter.filter((_, i) => i !== existingIdx);
          await guild.autoModerationRules.edit(pending.ruleId, {
            triggerMetadata: {
              keywordFilter: newFilter,
              regexPatterns: currentRegex,
              allowList: currentAllow,
            },
            reason: `Removed keyword "${pending.keyword}" via sushii-agent (approved by ${interaction.user.username})`,
          });
          const oldCount = currentFilter.length;
          const newCount = newFilter.length;
          await setAutomodStatus(btn, `✅ Removed \`${pending.keyword}\` from "${pending.ruleName}" (${oldCount} → ${newCount} keywords)`);
          systemMessage = `[System: Moderator approved. Keyword "${pending.keyword}" was successfully removed from automod rule "${pending.ruleName}" (${oldCount} → ${newCount} keywords). The rule is now live.]`;
          logger.info({ ruleId: pending.ruleId, keyword: pending.keyword, guildId: interaction.guildId }, "automod keyword removed");
        }
      } catch (err) {
        await setAutomodStatus(btn, `❌ Failed to remove \`${pending.keyword}\` from "${pending.ruleName}" — Discord API error`);
        systemMessage = `[System: Moderator approved, but the Discord API call failed: ${err}. The keyword was NOT removed. You may try again.]`;
        logger.error({ err, ruleId: pending.ruleId, keyword: pending.keyword }, "automod delete edit failed");
      }
    } else {
      await setAutomodStatus(btn, `❌ Rejected — \`${pending.keyword}\` kept in "${pending.ruleName}"`);
      systemMessage = `[System: Moderator rejected the keyword removal. "${pending.keyword}" was NOT removed from rule "${pending.ruleName}".]`;
    }

    await resumeAgent(btn, threadId, systemMessage);
  } catch (err) {
    logger.error({ err }, "Unexpected error in automod deletion approval handler");
  }
}

/** Handles initial server scan approval buttons: srv:{guildId}:{yes|no} */
export async function handleScanButton(
  interaction: ButtonInteraction,
  deps: {
    buildLoopOptions: BuildLoopOptionsFn;
    handleAgentResult: HandleAgentResultFn;
    withInteractionSpan: WithInteractionSpanFn;
  },
): Promise<void> {
  const rest = interaction.customId.slice(SCAN_BTN_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return;
  const guildId = rest.slice(0, colonIdx);
  const choice = rest.slice(colonIdx + 1); // "yes" | "no"

  const pending = pendingScans.get(guildId);
  if (!pending) {
    await interaction.reply({ content: "Scan approval expired — please re-trigger the bot.", flags: MessageFlags.Ephemeral });
    return;
  }

  pendingScans.delete(guildId);
  await interaction.deferUpdate();
  await disableScanButtons(interaction, choice === "yes" ? "Scan server" : "Skip");

  const guildConfig = config.guildConfig[guildId];
  if (!guildConfig) return;

  const emojiMap = buildEmojiMap(guildConfig.emojis ?? []);

  await withThreadLock(pending.threadId, () => deps.withInteractionSpan("discord.interaction", {
    "discord.thread_id": pending.threadId,
    "discord.guild_id": guildId,
    "discord.user_id": interaction.user.id,
    "discord.trigger": "scan_approval",
  }, async () => {
    const threadChannel = await client.channels.fetch(pending.threadId);
    if (!threadChannel?.isThread()) return;

    if (choice === "yes") {
      // Run scan agent loop first (fresh history, no user query)
      await threadChannel.sendTyping();
      const scanTypingInterval = setInterval(() => threadChannel.sendTyping(), 8000);
      const scanQuery = "[System: Perform initial server scan. Use listGuildChannels, listGuildRoles, and getRecentActivity to gather information about this server's structure and recent activity. Then call updateServerContext with a concise summary covering channels, roles, and any notable patterns. This is a background initialization task — do not address the user directly.]";
      try {
        const scanResult = await runAgentLoop(
          scanQuery,
          [],
          guildId,
          client as Client<true>,
          resolvedModules(guildConfig),
          BEHAVIOR_INSTRUCTIONS,
          {
            currentChannelId: pending.threadId,
            emojiMap: emojiMap,
            botId: client.user!.id,
            botUsername: client.user!.username,
            triggeringUser: pending.triggeringUser,
            currentChannel: pending.currentChannel,
            serverContext: null,
            memoryIndex: [],
            memoryCount: 0,
            memoryLimit: MEMORY_LIMIT,
          },
        );
        if (scanResult.response) {
          const componentMsgs = buildComponentMessages(scanResult.response);
          logger.child({ threadId: pending.threadId, guildId }).debug(
            { messageCount: componentMsgs.length, content: scanResult.response },
            "discord scan response sent",
          );
          for (const msgOpts of componentMsgs) {
            await threadChannel.send({ ...msgOpts, allowedMentions: { parse: [] } });
          }
        }
      } finally {
        clearInterval(scanTypingInterval);
      }
    }

    // Run original user query with fresh history and updated server context
    const freshServerContext = getServerContext(guildId);
    const freshMemoryIndex = listMemoryTitles(guildId);
    const freshMemoryCount = getMemoryCount(guildId);

    await threadChannel.sendTyping();
    const typingInterval = setInterval(() => threadChannel.sendTyping(), 8000);
    const toolTracker = new ToolProgressTracker(threadChannel);
    threadCancellations.delete(pending.threadId);
    threadTriggeringUsers.set(pending.threadId, pending.triggeringUser?.id ?? interaction.user.id);

    let agentResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
    try {
      agentResult = await runAgentLoop(
        pending.query,
        [],
        guildId,
        client as Client<true>,
        resolvedModules(config.guildConfig[guildId] ?? { allowedRoles: [] }),
        BEHAVIOR_INSTRUCTIONS,
        deps.buildLoopOptions(threadChannel, guildId, emojiMap, toolTracker, {
          threadContext: pending.threadContext || undefined,
          mentionedUsers: pending.mentionedUsers,
          triggeringUser: pending.triggeringUser,
          currentChannel: pending.currentChannel,
          serverContext: freshServerContext,
          memoryIndex: freshMemoryIndex,
          memoryCount: freshMemoryCount,
        }),
      );

      await deps.handleAgentResult(threadChannel, guildId, pending.threadId, agentResult, pending.threadContext, pending.triggeringUser?.id ?? interaction.user.id);
    } finally {
      await cleanupAgentRun(pending.threadId, typingInterval, toolTracker, agentResult);
    }
  }));
}
