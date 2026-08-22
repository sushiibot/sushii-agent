import { REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";
import { isSweepInFlight, runWikiSyncSweep } from "./sweep.ts";

const logger = getLogger("wiki-sync:command");

export const WIKI_SYNC_COMMAND_NAME = "wiki-sync";

const WIKI_SYNC_COMMAND = new SlashCommandBuilder()
  .setName(WIKI_SYNC_COMMAND_NAME)
  .setDescription("Force an early wiki-sync sweep of recent channel activity")
  .toJSON();

/** Registers /wiki-sync as a guild command for every guild that has wiki-sync enabled. Guild-scoped (not global) so it's available immediately, no propagation delay. */
export async function registerWikiSyncCommands(client: Client<true>): Promise<void> {
  const guildIds = getWikiSyncEnabledGuildIds();
  if (guildIds.length === 0) return;

  const rest = new REST().setToken(config.discordBotToken);
  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), { body: [WIKI_SYNC_COMMAND] });
      logger.info({ guildId }, "registered /wiki-sync command");
    } catch (err) {
      logger.error({ guildId, err }, "failed to register /wiki-sync command");
    }
  }
}

export async function handleWikiSyncCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  const guildConfig = config.guildConfig[interaction.guildId];
  const isAllowed = guildConfig ? interaction.member.roles.cache.hasAny(...guildConfig.allowedRoles) : false;
  if (!isAllowed) {
    await interaction.reply({ content: "You don't have permission to run this.", ephemeral: true });
    return;
  }

  if (isSweepInFlight(interaction.guildId)) {
    await interaction.reply({ content: "A sweep is already running for this server — hang tight.", ephemeral: true });
    return;
  }

  // Replies immediately rather than deferReply()+wait — a sweep (a full Pi session plus git
  // clone/push) can plausibly run past Discord's 15-minute interaction-token window, which
  // would leave a deferred reply stuck on "thinking..." forever with no way to resolve it. The
  // sweep runs detached; its actual result reaches the status channel via postSyncStatus
  // (sweep.ts), not this interaction, once it's done.
  const runId = crypto.randomUUID().slice(0, 8);
  const statusChannelId = guildConfig?.wiki?.statusChannelId;
  const followUp = statusChannelId
    ? `I'll post an update in <#${statusChannelId}> when it's done.`
    : "No status channel is configured for this server, so check the logs for the result.";
  await interaction.reply({ content: `Sweep started (run \`${runId}\`) — ${followUp}` });

  logger.info({ guildId: interaction.guildId, runId, triggeredBy: interaction.user.id }, "command triggered");

  runWikiSyncSweep(interaction.guildId, interaction.client, runId).catch((err) => {
    logger.error({ guildId: interaction.guildId, runId, err }, "command-triggered sweep failed");
  });
}
