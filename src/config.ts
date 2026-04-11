export interface GuildConfig {
  allowedRoles: string[];
  allowedChannels: string[];
  /** Discord emoji strings, e.g. ["<:blobheart:123>", "<a:wave:456>"] */
  emojis?: string[];
}

/** Build a name → Discord syntax map from an emojis array. */
export function buildEmojiMap(emojis: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const emoji of emojis) {
    const match = emoji.match(/^<a?:(\w+):\d+>$/);
    if (match) map[match[1]] = emoji;
  }
  return map;
}

export interface Config {
  discordBotToken: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiContextLimit: number;
  databasePath: string;
  feedbackPath: string;
  guildConfig: Record<string, GuildConfig>;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

import { readFileSync } from "fs";

function loadGuildConfig(): Record<string, GuildConfig> {
  const filePath = optional("GUILD_CONFIG_PATH", "./guild-config.json");
  let raw: Record<string, GuildConfig>;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`Failed to load guild config from ${filePath}: ${e}`);
  }
  return raw;
}

export const config: Config = {
  discordBotToken: required("DISCORD_BOT_TOKEN"),
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: optional("OPENAI_BASE_URL", "https://api.anthropic.com/v1"),
  openaiModel: optional("OPENAI_MODEL", "claude-opus-4-6"),
  openaiContextLimit: parseInt(optional("OPENAI_CONTEXT_LIMIT", "200000"), 10),
  databasePath: optional("DATABASE_PATH", "./data/sushii-agent.db"),
  feedbackPath: optional("FEEDBACK_PATH", "./data/feedback"),
  guildConfig: loadGuildConfig(),
};
