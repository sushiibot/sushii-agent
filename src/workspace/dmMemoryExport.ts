import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { agentMemory } from "../db/schema.ts";
import { CORE_PROFILE_TITLE } from "../core/stores/index.ts";
import { MEMORY_MD_CAP, USER_MD_CAP, readHomeTemplate } from "./home.ts";

/** The bot keys every DM's memory under this space id (DM = the owner). */
export const DM_SPACE_ID = "dm";

const MIGRATED_TAG = "(src: migrated)";

// Titles that describe drk rather than a topic go to USER.md.
const PROFILE_TITLE = /\b(user|profile|about|prefer(s|ences?)?|personal|bio|identity|likes?|dislikes?|habits?|routines?|family|friends?|drk)\b/i;

export interface DmMemoryRow {
  title: string;
  content: string;
  updatedAt: number;
}

export interface DmMemoryExport {
  user: string;
  memory: string;
  /** Bullets that didn't fit under a file's cap, for `memory/migrated-overflow.md`. */
  overflow: string[];
}

export function readDmMemoryRows(db: Database): DmMemoryRow[] {
  return drizzle({ client: db, schema: { agentMemory } })
    .select({ title: agentMemory.title, content: agentMemory.content, updatedAt: agentMemory.updatedAt })
    .from(agentMemory)
    .where(eq(agentMemory.guildId, DM_SPACE_ID))
    .all();
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, "").trim();
}

function oneLine(text: string): string {
  return text
    .split("\n")
    .map(stripListMarker)
    .filter((l) => l.length > 0)
    .join("; ");
}

/** Core profile: one tagged bullet per line; markdown headings are dropped (they carry no fact). */
function profileBullets(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map(stripListMarker)
    .filter((l) => l.length > 0)
    .map((l) => `- ${l} ${MIGRATED_TAG}`);
}

function entryBullet(row: DmMemoryRow): string {
  const body = oneLine(row.content);
  return body.length > 0 ? `- **${row.title.trim()}**: ${body} ${MIGRATED_TAG}` : `- ${row.title.trim()} ${MIGRATED_TAG}`;
}

/** Header, then bullets while the whole file stays within `cap`; the rest overflow. */
function fill(header: string, bullets: string[], cap: number, overflow: string[]): string {
  let out = header.endsWith("\n") ? header : `${header}\n`;
  for (const bullet of bullets) {
    if (out.length + bullet.length + 1 <= cap) out += `${bullet}\n`;
    else overflow.push(bullet);
  }
  return out;
}

export function formatDmMemoryExport(
  rows: DmMemoryRow[],
  opts: { userHeader?: string; memoryHeader?: string } = {},
): DmMemoryExport {
  const userHeader = opts.userHeader ?? readHomeTemplate("USER.md");
  const memoryHeader = opts.memoryHeader ?? readHomeTemplate("MEMORY.md");
  const byRecent = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const core = byRecent.find((r) => r.title === CORE_PROFILE_TITLE);
  const entries = byRecent.filter((r) => r.title !== CORE_PROFILE_TITLE && r.content.trim().length + r.title.trim().length > 0);

  const userBullets = [...(core ? profileBullets(core.content) : []), ...entries.filter((r) => PROFILE_TITLE.test(r.title)).map(entryBullet)];
  const memoryBullets = entries.filter((r) => !PROFILE_TITLE.test(r.title)).map(entryBullet);

  const overflow: string[] = [];
  const user = fill(userHeader, userBullets, USER_MD_CAP, overflow);
  const memory = fill(memoryHeader, memoryBullets, MEMORY_MD_CAP, overflow);
  return { user, memory, overflow };
}

export function formatOverflowFile(overflow: string[]): string {
  return `# Migrated memory that didn't fit under the USER.md / MEMORY.md caps\n\nPromote what still matters; delete the rest.\n\n${overflow.join("\n")}\n`;
}
