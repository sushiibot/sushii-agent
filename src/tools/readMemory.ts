import { readMemory, readAllMemories, searchMemories } from "../db/memory.ts";

export function readMemoryTool({
  guildId,
  title,
  query,
}: {
  guildId: string;
  title?: string;
  query?: string;
}) {
  if (title) {
    const row = readMemory(guildId, title);
    if (!row) return { error: `No memory found with title "${title}"` };
    return row;
  }
  if (query) {
    const rows = searchMemories(guildId, query);
    if (rows.length === 0) return { error: `No memories matched "${query}"` };
    return rows;
  }
  return readAllMemories(guildId);
}
