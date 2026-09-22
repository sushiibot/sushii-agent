import type { Client } from "discord.js";
import type { MakeWikiSourceContext } from "../modules/wiki-sync/scheduler.ts";
import { makeDiscordWikiSyncContext } from "./discord/wikiSync.ts";
import { makeSlackWikiSyncContext, type SlackWikiSyncClient } from "./slack/wikiSync.ts";

export interface CombinedWikiSyncDeps {
  discordClient: Client<true>;
  /** Resolved lazily — Slack's client + workspace URL are set after auth.test, which runs after this
   *  factory is built. Returns undefined until Slack is wired (or when it's disabled). */
  getSlack: () => { client: SlackWikiSyncClient; workspaceUrl: string } | undefined;
}

/** The wiki-sync source factory switched by surface, so one shared wiki can be swept across surfaces.
 *  A Slack source with Slack unwired → null (the scheduler skips it); an unknown surface → null. */
export function makeCombinedWikiSourceContext(deps: CombinedWikiSyncDeps): MakeWikiSourceContext {
  return (wikiId, source) => {
    if (source.surface === "discord") return makeDiscordWikiSyncContext(deps.discordClient, wikiId, source);
    if (source.surface === "slack") {
      const slack = deps.getSlack();
      return slack ? makeSlackWikiSyncContext(slack.client, slack.workspaceUrl, wikiId, source) : null;
    }
    return null;
  };
}
