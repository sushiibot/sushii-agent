import { Client, GatewayIntentBits, Partials } from "discord.js";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, // owner DM conductor (orchestration) — DMs don't arrive without this
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration, // audit-log entries: screening records bans/kicks/timeouts as outcomes
    GatewayIntentBits.AutoModerationExecution, // AutoMod blocks, shown on screening posts
  ],
  partials: [Partials.Message, Partials.Channel], // Channel partial required to receive DMs
});
