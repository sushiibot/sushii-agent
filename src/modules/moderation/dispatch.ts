import { MessageFlags, type Client, type Message, type ThreadChannel } from "discord.js";
import { client } from "../../discordClient.ts";
import { getLogger } from "../../logger.ts";
import { resolvedModules, type GuildConfig } from "../../config.ts";
import { loadConversation } from "../../db/conversations.ts";
import { getServerContext, listMemoryTitles, getMemoryCount } from "../../db/memory.ts";
import {
  ToolProgressTracker,
  buildTextDisplayContainer,
  withThreadLock,
  cleanupAgentRun,
  threadCancellations,
  buildLoopOptions,
} from "../../agent/delivery.ts";
import { runAgentLoop, type AgentLoopResult, type AutoModTriggerContext } from "../../agent/loop.ts";
import { BEHAVIOR_INSTRUCTIONS, buildAutoModPromptSection } from "./prompt.ts";
import { autoModCooldowns } from "./state.ts";

const logger = getLogger("moderation/dispatch");

const DEFAULT_AUTOMOD_COOLDOWN_SECONDS = 60;

/** Deliver-result callback shape, matching bot.ts's handleAgentResult — injected to avoid dispatch.ts importing bot.ts. */
export type DeliverAutoModResult = (
  thread: ThreadChannel,
  guildId: string,
  threadId: string,
  agentResult: AgentLoopResult,
  threadContext: string | null,
  triggeredByUserId: string,
) => Promise<void>;

/** Mod role pinged by an authorized role — doesn't require a bot mention. */
export function isAutoModEligible(message: Message, guildConfig: GuildConfig): boolean {
  return Boolean(
    guildConfig.modRoleId &&
      guildConfig.alertsChannelId &&
      message.mentions.roles.has(guildConfig.modRoleId) &&
      (!guildConfig.autoModTriggerRoleIds?.length ||
        (message.member?.roles.cache.hasAny(...guildConfig.autoModTriggerRoleIds) ?? false)),
  );
}

/**
 * Collapses repeated pings for the same incident into a single investigation.
 * Returns true and records the trigger time if the cooldown has elapsed, false if suppressed.
 */
export function checkAndSetAutoModCooldown(guildId: string, channelId: string, guildConfig: GuildConfig): boolean {
  const cooldownKey = `${guildId}:${channelId}`;
  const cooldownMs = (guildConfig.autoModCooldownSeconds ?? DEFAULT_AUTOMOD_COOLDOWN_SECONDS) * 1000;
  const lastTriggered = autoModCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastTriggered < cooldownMs) return false;
  autoModCooldowns.set(cooldownKey, Date.now());
  return true;
}

/**
 * Posts the "investigating" alert anchor, opens its thread, and runs the agent loop
 * against the auto-mod trigger context. Callers must have already checked
 * isAutoModEligible/checkAndSetAutoModCooldown.
 */
export async function handleAutoModTrigger(
  message: Message,
  guildId: string,
  guildConfig: GuildConfig,
  emojiMap: Record<string, string>,
  deliverResult: DeliverAutoModResult,
): Promise<void> {
  const modRoleId = guildConfig.modRoleId!;
  const alertsChannelId = guildConfig.alertsChannelId!;

  try {
    const alertsChannel = await client.channels.fetch(alertsChannelId);
    if (!alertsChannel?.isTextBased() || alertsChannel.isDMBased() || alertsChannel.guildId !== guildId) {
      logger.error({ alertsChannelId }, "alertsChannelId is not a guild text channel");
      return;
    }

    const incidentChannelName =
      message.channel.isTextBased() && !message.channel.isDMBased() && "name" in message.channel
        ? (message.channel as { name: string }).name
        : message.channelId;

    const triggerMessageLink = `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;

    // Sent as Components V2 from the start since IS_COMPONENTS_V2 can't be toggled on via a later edit.
    // No mod-role mention here — send_alert_message edits this message in place once the
    // investigation concludes, and Discord notifies on a mention newly added via edit.
    const anchorContainer = buildTextDisplayContainer(
      `🔍 Auto-mod investigating an incident in <#${message.channelId}> — [triggering message](${triggerMessageLink})...`,
    );
    const anchor = await alertsChannel.send({
      components: [anchorContainer],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });

    const thread = await anchor.startThread({
      name: "auto-mod investigation",
    });

    // Resolve replied-to info if present
    let repliedToUserId: string | undefined;
    let repliedToMessageId: string | undefined;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        if (ref && !ref.author.bot) {
          repliedToUserId = ref.author.id;
          repliedToMessageId = ref.id;
        }
      } catch {
        // non-fatal
      }
    }

    const immuneIds = [...new Set([...(guildConfig.modImmuneRoleIds ?? []), ...guildConfig.allowedRoles])];
    const newMemberThresholdDays = guildConfig.newMemberThresholdDays ?? 3;

    const autoModTrigger: AutoModTriggerContext = {
      reporterUserId: message.author.id,
      reporterUsername: message.author.username,
      incidentChannelId: message.channelId,
      incidentChannelName,
      triggerMessageContent: message.content.slice(0, 500),
      triggerMessageId: message.id,
      repliedToUserId,
      repliedToMessageId,
      modRoleId,
      modImmuneRoleIds: immuneIds,
      newMemberThresholdDays,
      anchorMessageId: anchor.id,
    };

    const serverContext = getServerContext(guildId);
    const memoryIndex = listMemoryTitles(guildId);
    const memoryCount = getMemoryCount(guildId);

    const query = `[Auto-mod trigger] Mod role was pinged by ${message.author.username} in #${incidentChannelName}. Message: "${message.content.slice(0, 300)}"`;

    await withThreadLock(thread.id, async () => {
      const { messages: existingHistory, initialThreadContext } = loadConversation(thread.id);
      const threadContext = initialThreadContext ?? "";

      await thread.sendTyping();
      const typingInterval = setInterval(() => thread.sendTyping(), 8000);

      const toolTracker = new ToolProgressTracker(thread);
      threadCancellations.delete(thread.id);

      let agentResult: AgentLoopResult | undefined;
      try {
        agentResult = await runAgentLoop(
          query,
          existingHistory,
          guildId,
          client as Client<true>,
          resolvedModules(guildConfig),
          BEHAVIOR_INSTRUCTIONS,
          buildLoopOptions(thread, guildId, emojiMap, toolTracker, {
            threadContext: threadContext || undefined,
            serverContext,
            memoryIndex,
            memoryCount,
            extraOpts: {
              autoModTrigger,
              extraPromptSections: [buildAutoModPromptSection(autoModTrigger)],
            },
          }),
        );
      } finally {
        await cleanupAgentRun(thread.id, typingInterval, toolTracker, agentResult);
      }

      if (!agentResult) return;
      await deliverResult(thread, guildId, thread.id, agentResult, threadContext, client.user!.id);
    });
  } catch (err) {
    logger.error({ err, guildId, channelId: message.channelId }, "Error in handleAutoModTrigger");
  }
}
