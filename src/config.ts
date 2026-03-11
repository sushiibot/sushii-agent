export interface GuildConfig {
  allowedUsers: string[];
  allowedChannels: string[];
}

export interface Config {
  discordBotToken: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  databasePath: string;
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

export const config: Config = {
  discordBotToken: required("DISCORD_BOT_TOKEN"),
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: optional("OPENAI_BASE_URL", "https://api.anthropic.com/v1"),
  openaiModel: optional("OPENAI_MODEL", "claude-opus-4-6"),
  databasePath: optional("DATABASE_PATH", "./data/modassist.db"),
  guildConfig: JSON.parse(required("GUILD_CONFIG")),
};
