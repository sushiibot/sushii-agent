import type { AuthorRef, PlatformRenderer, PromptGuidance, RenderContext } from "../../core/contracts.ts";

/** Discord renders a lone ">" as plain text instead of an empty blockquote line. */
function fixBlockquotes(text: string): string {
  return text.replace(/^>$/gm, "> ");
}

/** The model writes u:ID, c:ID, t:SECONDS[:FLAG], e:name instead of raw angle-bracket syntax. */
function expandDiscordTokens(text: string, emojiMap?: Record<string, string>): string {
  let result = text
    .replace(/\bu:(\d{15,20})\b/g, "<@$1>")
    .replace(/\bc:(\d{15,20})\b/g, "<#$1>")
    .replace(/\bt:(\d{8,12})(?::([A-Za-z]))?\b/g, (_, secs, flag) => `<t:${secs}:${flag ?? "f"}>`);

  if (emojiMap) {
    result = result.replace(/\be:(\w+)\b/g, (match, name) => emojiMap[name] ?? match);
  }

  return result;
}

/** The model writes msg:CHANNEL_ID/MESSAGE_ID citations instead of full jump links. */
function expandMessageLinks(text: string, guildId: string): string {
  return text.replace(
    /msg:(\d+)\/(\d+)/g,
    (_, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  );
}

/**
 * Unwraps a single-backtick span that contains already-expanded markup — the model
 * sometimes wraps whole evidence lines in inline code, which suppresses mentions,
 * timestamps, and emoji inside it.
 */
function unwrapCodeSpansContainingMarkup(text: string): string {
  return text.replace(
    /`([^`\n]*(?:<@!?\d{15,20}>|<#\d{15,20}>|<t:\d{8,12}:[A-Za-z]>|<a?:\w+:\d+>)[^`\n]*)`/g,
    "$1",
  );
}

export function renderDiscordText(text: string, guildId: string, emojiMap?: Record<string, string>): string {
  let result = fixBlockquotes(text);
  result = expandDiscordTokens(result, emojiMap);
  result = expandMessageLinks(result, guildId);
  result = unwrapCodeSpansContainingMarkup(result);
  return result;
}

export class DiscordPlatformRenderer implements PlatformRenderer {
  renderText(text: string, ctx: RenderContext): string {
    return renderDiscordText(text, ctx.spaceId, ctx.emojiMap);
  }

  promptGuidance(ctx: RenderContext): PromptGuidance {
    const emojiNames = ctx.emojiMap ? Object.keys(ctx.emojiMap) : [];
    const emojiSection = emojiNames.length > 0
      ? `Server emoji available via e:name — ${emojiNames.join(", ")}.`
      : undefined;

    return {
      sections: {
        emoji: emojiSection,
        channel: "Use c:CHANNEL_ID for channel references and msg:CHANNEL_ID/MESSAGE_ID to cite a specific message.",
        threadContext: "Use t:SECONDS[:FLAG] for Discord timestamp formatting (FLAG defaults to f) instead of writing out dates.",
      },
    };
  }

  describeUser(author: AuthorRef): string {
    return author.displayName ?? author.username ?? author.userId;
  }
}
