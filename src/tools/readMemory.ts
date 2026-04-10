import { readMemory, readAllMemories } from "../db/memory.ts";

export function readMemoryTool({
  guildId,
  title,
}: {
  guildId: string;
  title?: string;
}) {
  if (title) {
    const row = readMemory(guildId, title);
    if (!row) return { error: `No memory found with title "${title}"` };
    return row;
  }
  return readAllMemories(guildId);
}
