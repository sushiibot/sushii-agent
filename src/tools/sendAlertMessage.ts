import type { Client, GuildTextBasedChannel } from "discord.js";

export interface SendAlertMessageArgs {
  message: string;
  guildId: string;
  client: Client<true>;
  alertsChannelId: string;
  modRoleId: string;
  dryRun?: boolean;
  /** ID of the silent anchor message to edit in place, delivering the mod-role ping on first mention. Falls back to sending a new message if editing fails. */
  anchorMessageId?: string;
}

export interface SendAlertMessageResult {
  ok: true;
  messageId: string;
}

export async function sendAlertMessage(
  args: SendAlertMessageArgs,
): Promise<SendAlertMessageResult | { error: string }> {
  let channel: GuildTextBasedChannel;
  try {
    const fetched = await args.client.channels.fetch(args.alertsChannelId);
    if (!fetched?.isTextBased() || fetched.isDMBased() || fetched.guildId !== args.guildId) {
      return { error: `Alerts channel ${args.alertsChannelId} is invalid or not in this guild.` };
    }
    channel = fetched as GuildTextBasedChannel;
  } catch (err) {
    return { error: `Failed to fetch alerts channel: ${err}` };
  }

  // Prepend the role mention ourselves — don't rely on LLM to include role ID syntax
  const dryRunTag = args.dryRun ? "🧪 **DRY RUN — no action was actually taken.**\n" : "";
  const content = `<@&${args.modRoleId}> ${dryRunTag}${args.message}`;

  if (args.anchorMessageId) {
    try {
      const anchor = await channel.messages.fetch(args.anchorMessageId);
      const edited = await anchor.edit({
        content,
        allowedMentions: { roles: [args.modRoleId] },
      });
      return { ok: true, messageId: edited.id };
    } catch {
      // Anchor may have been deleted or is otherwise unreachable — fall through to sending fresh.
    }
  }

  try {
    const sent = await channel.send({
      content,
      allowedMentions: { roles: [args.modRoleId] },
    });
    return { ok: true, messageId: sent.id };
  } catch (err) {
    return { error: `Failed to send alert: ${err}` };
  }
}
