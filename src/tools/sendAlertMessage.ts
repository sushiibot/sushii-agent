import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { renderModelText } from "../utils/discordText.ts";

export interface SendAlertMessageArgs {
  findings: string;
  action: string;
  guildId: string;
  client: Client<true>;
  alertsChannelId: string;
  modRoleId: string;
  dryRun?: boolean;
  /** ID of the silent anchor message to edit in place, delivering the mod-role ping on first mention. Falls back to sending a new message if editing fails. */
  anchorMessageId?: string;
  /** Channel + message the mod-role ping originated from — always rendered as its own section, regardless of what the model cites. */
  incidentChannelId?: string;
  triggerMessageId?: string;
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

  const renderOpts = { guildId: args.guildId };
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder({ content: `<@&${args.modRoleId}> 🚨 **Auto-mod alert**` }),
  );

  container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
  const triggerLine =
    args.incidentChannelId && args.triggerMessageId
      ? `Triggered by: https://discord.com/channels/${args.guildId}/${args.incidentChannelId}/${args.triggerMessageId}`
      : "(trigger info unavailable)";
  container.addTextDisplayComponents(new TextDisplayBuilder({ content: `**Trigger**\n${triggerLine}` }));

  container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
  container.addTextDisplayComponents(
    new TextDisplayBuilder({ content: `**Findings**\n${renderModelText(args.findings, renderOpts)}` }),
  );

  container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
  container.addTextDisplayComponents(
    new TextDisplayBuilder({ content: `**Action taken**\n${renderModelText(args.action, renderOpts)}` }),
  );

  if (args.dryRun) {
    container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
    container.addTextDisplayComponents(
      new TextDisplayBuilder({ content: "🧪 **DRY RUN — no action was actually taken.**" }),
    );
  }

  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    allowedMentions: { roles: [args.modRoleId] },
  };

  if (args.anchorMessageId) {
    try {
      const anchor = await channel.messages.fetch(args.anchorMessageId);
      const edited = await anchor.edit(payload);
      return { ok: true, messageId: edited.id };
    } catch {
      // Anchor may have been deleted or is otherwise unreachable — fall through to sending fresh.
    }
  }

  try {
    const sent = await channel.send(payload);
    return { ok: true, messageId: sent.id };
  } catch (err) {
    return { error: `Failed to send alert: ${err}` };
  }
}
