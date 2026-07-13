import type { Client, GuildTextBasedChannel } from "discord.js";

export interface SendAlertMessageArgs {
  message: string;
  guildId: string;
  client: Client<true>;
  alertsChannelId: string;
  modRoleId: string;
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
  const content = `<@&${args.modRoleId}> ${args.message}`;

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
