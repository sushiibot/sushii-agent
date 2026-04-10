import { setServerContext } from "../db/memory.ts";

const MAX_SERVER_CONTEXT_CHARS = 4000;

export function updateServerContextTool({
  guildId,
  content,
}: {
  guildId: string;
  content: string;
}) {
  if (content.length > MAX_SERVER_CONTEXT_CHARS) {
    return {
      error: `Server context too long (${content.length} chars, max ${MAX_SERVER_CONTEXT_CHARS}). Condense the content and try again.`,
    };
  }
  setServerContext(guildId, content);
  return { ok: true };
}
