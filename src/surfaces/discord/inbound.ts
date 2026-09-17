// The user-turn framing the gateway hands the core as InboundMessage.text. Extracted as a pure,
// tested function because it is the highest-traffic string in the system and its old producer
// (bot.ts) is being deleted — see inbound.parity.test.ts for the golden. The surface owns this
// framing verbatim (the core relays it); it ports bot.ts's MessageCreate query build byte-for-byte.

const BARE_PING_FALLBACK =
  "[No message text — review the recent activity shown in your context, investigate anything unclear or needing moderator attention, and summarize what's going on. If nothing needs attention, say so briefly.]";

export interface TriggerTextInput {
  botId: string;
  /** The raw Discord message content (message.content). */
  rawContent: string;
  emojiMap: Record<string, string>;
  authorUsername: string;
  authorId: string;
  /** Reply-to-a-non-bot context, already formatted ("" when none). Prepended before the wrapper. */
  replyContext: string;
  /** Lazily resolves buildMessageContent(message) — only invoked for a bare ping (text-less
   *  trigger), so a normal mention never pays the flatten cost. */
  resolveBarePing?: () => string;
}

export function buildTriggerText(input: TriggerTextInput): string {
  const botMentionRe = new RegExp(`<@!?${input.botId}>`, "g");
  const rawQuery = input.rawContent.replace(botMentionRe, "").trim();
  const isBarePing = rawQuery.length === 0;
  const emojiQuery = rawQuery.replace(/<a?:(\w+):\d+>/g, (match, name) => input.emojiMap[name] ?? match);
  const normalizedQuery = emojiQuery.replace(/https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/g, "msg:$1/$2");

  let body: string;
  if (!isBarePing) {
    body = normalizedQuery;
  } else {
    const flattened = (input.resolveBarePing?.() ?? "").replace(botMentionRe, "").trim();
    const attached = flattened && flattened !== "[empty message]" ? `${flattened}\n` : "";
    body = `${attached}${BARE_PING_FALLBACK}`;
  }
  return `${input.replyContext}[Message from ${input.authorUsername} (<@${input.authorId}>)]\n${body}`;
}
