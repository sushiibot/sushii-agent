export interface RenderModelTextOptions {
  guildId: string;
  emojiMap?: Record<string, string>;
}

/**
 * Single entry point for turning model-authored text into Discord-ready markup.
 * Every place that sends model output to Discord — chat replies, interim updates,
 * automod alerts — must go through this, not the individual expansion steps below.
 * That's what keeps `u:`/`c:`/`t:`/`e:`/`msg:` tokens from leaking through as raw
 * text when a new send site is added.
 */
export function renderModelText(text: string, opts: RenderModelTextOptions): string {
  let result = fixBlockquotes(text);
  result = expandDiscordTokens(result, opts.emojiMap);
  result = expandMessageLinks(result, opts.guildId);
  result = unwrapCodeSpansContainingMarkup(result);
  return result;
}

/** Discord renders a lone ">" as plain text instead of an empty blockquote line. */
function fixBlockquotes(text: string): string {
  return text.replace(/^>$/gm, "> ");
}

/** The model writes u:ID, c:ID, t:SECONDS[:FLAG], e:name instead of raw angle-bracket syntax. */
function expandDiscordTokens(text: string, emojiMap?: Record<string, string>): string {
  let result = text
    .replace(/\bu:(\d{15,20})\b/g, "<@$1>")
    .replace(/\bc:(\d{15,20})\b/g, "<#$1>")
    // Flag defaults to :f when the model drops it.
    .replace(/\bt:(\d{8,12})(?::([A-Za-z]))?\b/g, (_, secs, flag) => `<t:${secs}:${flag ?? "f"}>`);

  if (emojiMap) {
    result = result.replace(/\be:(\w+)\b/g, (match, name) => emojiMap[name] ?? match);
  }

  return result;
}

/**
 * The model sometimes wraps whole evidence lines in a single inline-code span,
 * which suppresses Discord markup (mentions, timestamps, emoji) inside it.
 * Unwrap any single-backtick span that contains already-expanded markup.
 */
function unwrapCodeSpansContainingMarkup(text: string): string {
  return text.replace(
    /`([^`\n]*(?:<@!?\d{15,20}>|<#\d{15,20}>|<t:\d{8,12}:[A-Za-z]>|<a?:\w+:\d+>)[^`\n]*)`/g,
    "$1",
  );
}

/** The model writes msg:CHANNEL_ID/MESSAGE_ID citations instead of full jump links. */
function expandMessageLinks(text: string, guildId: string): string {
  return text.replace(
    /msg:(\d+)\/(\d+)/g,
    (_, channelId, messageId) =>
      `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  );
}
