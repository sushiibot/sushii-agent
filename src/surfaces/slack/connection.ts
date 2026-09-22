import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { retryPolicies } from "@slack/web-api";
import { getLogger } from "../../logger.ts";

const logger = getLogger("surfaces/slack/connection");

// Slack app configuration (Socket Mode) — cumulative across ingestion, the agent loop, and the
// wiki-sync source:
//   App-level token (xapp-): connections:write
//   Bot token scopes: channels:history, channels:read, groups:history, groups:read,
//     im:history, im:read, mpim:history, mpim:read,  // ingestion + backfill
//     app_mentions:read, chat:write, reactions:write, users:read  // agent loop + wiki notifier/name resolution
//   Event subscriptions: message.channels, message.groups, message.im, message.mpim, app_mention
// The bot never auto-joins channels, so channels:join is intentionally not required — it ingests
// and responds only in channels it has been invited to.

export interface SlackConfig {
  botToken: string;
  appToken: string;
}

/** Construct the Socket Mode Bolt app WITHOUT starting it, so a later phase can register its own
 *  listeners on the same instance before `app.start()`. `ignoreSelf: false` keeps the bot's own
 *  messages in the archive; the WebClient auto-retries 429s (honoring Retry-After) for backfill. */
export function createSlackApp(cfg: SlackConfig): { app: App; receiver: SocketModeReceiver } {
  const slackLogger = {
    debug: (...m: unknown[]) => logger.debug({ slack: m }),
    info: (...m: unknown[]) => logger.info({ slack: m }),
    warn: (...m: unknown[]) => logger.warn({ slack: m }),
    error: (...m: unknown[]) => logger.error({ slack: m }),
    setLevel: () => {},
    getLevel: () => LogLevel.INFO,
    setName: () => {},
  };
  // Explicit receiver so we can silence the per-ping debug spam and reach `receiver.client` for the
  // flap supervisor. pingPongLoggingEnabled:false drops the twice-a-second ping/pong debug lines.
  const receiver = new SocketModeReceiver({
    appToken: cfg.appToken,
    logger: slackLogger,
    logLevel: LogLevel.INFO,
    pingPongLoggingEnabled: false,
  });
  const app = new App({
    token: cfg.botToken,
    receiver,
    ignoreSelf: false,
    logLevel: LogLevel.INFO,
    logger: slackLogger,
    clientOptions: { retryConfig: retryPolicies.fiveRetriesInFiveMinutes },
  });
  return { app, receiver };
}
