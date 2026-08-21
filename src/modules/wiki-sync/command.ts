import { REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { getWikiSyncEnabledGuildIds } from "./guilds.ts";
import { runWikiSyncSweep } from "./sweep.ts";

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

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await runWikiSyncSweep(interaction.guildId);
    if (!result.ran) {
      await interaction.editReply(`Sweep not started: ${result.reason}`);
    } else if (result.reason === "no new messages") {
      await interaction.editReply("Sweep complete — no new messages to review.");
    } else if (result.commitSha) {
      await interaction.editReply(`Sweep complete — pushed commit \`${result.commitSha.slice(0, 7)}\`.`);
    } else {
      await interaction.editReply("Sweep complete — no wiki changes were needed.");
    }
  } catch (err) {
    logger.error({ guildId: interaction.guildId, err }, "wiki-sync command failed");
    await interaction.editReply("Sweep failed — check logs.");
  }
}
