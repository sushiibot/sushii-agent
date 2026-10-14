import { readFileSync } from "node:fs";
import { z } from "zod";

const optional = z.string().min(1).optional();

const schema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  // Required only by the Discord bot entrypoint, so it is checked on demand (requireDiscordBotToken).
  DISCORD_BOT_TOKEN: optional,
  EXA_API_KEY: optional,
  SUSHII_MCP_TOKEN: optional,
  MNEMOSYNE_MCP_TOKEN: optional,
  DISCORD_OAUTH_CLIENT_SECRET: optional,
  // The entrypoint loads it into ssh-agent and unsets it; listed so a stray copy is still redacted.
  WIKI_SYNC_SSH_PRIVATE_KEY_B64: optional,
  WIKI_SYNC_HTTPS_TOKEN: optional,
  SLACK_BOT_TOKEN: optional,
  SLACK_APP_TOKEN: optional,
  BUZZ_PRIVATE_KEY: optional,
  GRAFANA_API_TOKEN: optional,
  LINEAR_API_KEY: optional,
});

export type Secrets = Readonly<z.infer<typeof schema>>;

const extraValues = new Set<string>();

/** One secret by name, with the NAME_FILE fallback; empty counts as unset. */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`];
  if (!file) return env[name] || undefined;
  try {
    return readFileSync(file, "utf8").trimEnd() || undefined;
  } catch (err) {
    throw new Error(`${name}_FILE could not be read (${(err as NodeJS.ErrnoException).code})`);
  }
}

/** Adds a value derived at runtime (e.g. an encoded auth header) to log scrubbing. */
export function registerSecretValue(value: string): void {
  extraValues.add(value);
}

/** For secrets whose env var name comes from runtime config: reads it and adds the value to log scrubbing. */
export function readDynamicSecret(name: string): string | undefined {
  const value = readSecret(name);
  if (value) registerSecretValue(value);
  return value;
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const raw = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, readSecret(k, env)]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Names and issue codes only: some zod messages echo the received value.
    const names = parsed.error.issues.map((i) => `${i.path.join(".")} (${i.code})`);
    throw new Error(`Missing or invalid secrets: ${names.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}

export const secrets = loadSecrets();

export function knownSecretValues(): string[] {
  return [...Object.values(secrets), ...extraValues].filter((v): v is string => typeof v === "string" && v.length >= 8);
}

export function requireDiscordBotToken(): string {
  if (!secrets.DISCORD_BOT_TOKEN) throw new Error("Missing required env var: DISCORD_BOT_TOKEN");
  return secrets.DISCORD_BOT_TOKEN;
}
