// One-time export of the bot's owner-DM memory into personal-workspace home files.
//
// Usage (in the bot container, where the SQLite db lives):
//   docker exec sushii_agent bun scripts/export-dm-memory.ts --out /data/dm-memory-export [--db <path>]
//
// Writes <out>/USER.md, <out>/MEMORY.md and, when entries overflow the caps,
// <out>/memory/migrated-overflow.md. It never writes into the workspace; it prints the copy steps.

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatCopySteps, formatDmMemoryExport, formatOverflowFile, readDmMemoryRows } from "../src/workspace/dmMemoryExport.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    db: { type: "string" },
  },
});

if (!values.out) {
  console.error("usage: bun scripts/export-dm-memory.ts --out <dir> [--db <sqlite path>]");
  process.exit(1);
}

const out = resolve(values.out);
// Same default as the bot's config (DATABASE_PATH), without requiring the bot's other env vars.
const dbPath = values.db ?? process.env.DATABASE_PATH ?? "./data/sushii-agent.db";

const db = new Database(dbPath, { readonly: true });
const rows = readDmMemoryRows(db);
db.close();

const result = formatDmMemoryExport(rows);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "USER.md"), result.user);
writeFileSync(join(out, "MEMORY.md"), result.memory);
const written = ["USER.md", "MEMORY.md"];
if (result.overflow.length > 0) {
  mkdirSync(join(out, "memory"), { recursive: true });
  writeFileSync(join(out, "memory", "migrated-overflow.md"), formatOverflowFile(result.overflow));
  written.push("memory/migrated-overflow.md");
}

console.log(`exported ${rows.length} DM memory rows from ${dbPath} to ${out}: ${written.join(", ")}`);
if (result.overflow.length > 0) console.log(`${result.overflow.length} entries exceeded the caps; they are in memory/migrated-overflow.md`);

// The mnemosyne client exposes only recall (query-bound, top-k) and remember: there is no
// list/recall-all operation, so a complete bank export isn't possible from here.
if (process.env.MNEMOSYNE_MCP_URL) {
  console.log("mnemosyne: skipped. The client has no list/recall-all operation, so the DM bank can't be exported in full.");
}

console.log("\nRouting (check it; move any misfiled bullet by hand before committing):");
for (const { title, file } of result.routing) console.log(`  ${file.padEnd(9)} ${title}`);

const indent = (steps: string[]) => steps.map((l) => `  ${l}`).join("\n");
console.log(`
Copy into the workspace home. Run this before the agent has written its own memory: it replaces
USER.md and MEMORY.md. Read the diff step's output before you commit.

${indent(formatCopySteps(out, written))}

Ran this script on the host instead of in the bot container? The first step becomes:

${indent(formatCopySteps(out, written, { onHost: true }).slice(0, 1))}`);
