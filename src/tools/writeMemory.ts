import { upsertMemory } from "../db/memory.ts";

export function writeMemoryTool({
  guildId,
  title,
  content,
}: {
  guildId: string;
  title: string;
  content: string;
}) {
  return upsertMemory(guildId, title, content);
}
