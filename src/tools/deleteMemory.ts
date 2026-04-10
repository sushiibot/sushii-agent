import { deleteMemory } from "../db/memory.ts";

export function deleteMemoryTool({
  guildId,
  title,
}: {
  guildId: string;
  title: string;
}) {
  const deleted = deleteMemory(guildId, title);
  if (!deleted) return { error: `No memory found with title "${title}"` };
  return { ok: true };
}
