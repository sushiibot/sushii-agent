import { Client, GatewayIntentBits, Partials } from "discord.js";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages, // owner DM conductor (orchestration) — DMs don't arrive without this
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel], // Channel partial required to receive DMs
});
