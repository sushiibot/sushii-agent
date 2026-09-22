import { App, LogLevel } from "@slack/bolt";
import { retryPolicies } from "@slack/web-api";
import { getLogger } from "../../logger.ts";

const logger = getLogger("surfaces/slack/connection");

// Slack app configuration drk must set up (Socket Mode):
//   App-level token (xapp-): connections:write
//   Bot token scopes: channels:history, channels:read, groups:history, groups:read,
//     im:history, im:read, mpim:history, mpim:read
//   Event subscriptions: message.channels, message.groups, message.im, message.mpim
// Phase 1 does not auto-join channels, so channels:join is intentionally not required.

export interface SlackConfig {
  botToken: string;
  appToken: string;
}

/** Construct the Socket Mode Bolt app WITHOUT starting it, so a later phase can register its own
 *  listeners on the same instance before `app.start()`. `ignoreSelf: false` keeps the bot's own
 *  messages in the archive; the WebClient auto-retries 429s (honoring Retry-After) for backfill. */
export function createSlackApp(cfg: SlackConfig): App {
  return new App({
    token: cfg.botToken,
    appToken: cfg.appToken,
    socketMode: true,
    ignoreSelf: false,
    logLevel: LogLevel.INFO,
    logger: {
      debug: (...m) => logger.debug({ slack: m }),
      info: (...m) => logger.info({ slack: m }),
      warn: (...m) => logger.warn({ slack: m }),
      error: (...m) => logger.error({ slack: m }),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
    clientOptions: { retryConfig: retryPolicies.fiveRetriesInFiveMinutes },
  });
}
