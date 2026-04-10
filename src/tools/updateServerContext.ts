import { setServerContext } from "../db/memory.ts";

export function updateServerContextTool({
  guildId,
  content,
}: {
  guildId: string;
  content: string;
}) {
  setServerContext(guildId, content);
  return { ok: true };
}
