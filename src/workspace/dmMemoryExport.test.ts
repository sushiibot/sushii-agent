import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/index.ts";
import { CORE_PROFILE_TITLE } from "../core/stores/index.ts";
import { formatDmMemoryExport, formatOverflowFile, readDmMemoryRows } from "./dmMemoryExport.ts";
import { MEMORY_MD_CAP, readHomeTemplate } from "./home.ts";

function fixtureDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  const insert = db.prepare("INSERT INTO agent_memory (guild_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  insert.run("dm", CORE_PROFILE_TITLE, "## About\n- Lives in Seattle\n- Prefers TypeScript\n\nWorks nights", 1, 5);
  insert.run("dm", "Coffee preferences", "Oat milk flat white", 1, 4);
  insert.run("dm", "sushii deploy notes", "Deploy via ansible\n- host: apps", 1, 3);
  insert.run("dm", "Reading list", "Dune", 1, 6);
  insert.run("123456789", "Guild rules", "not a DM row", 1, 7);
  return db;
}

describe("DM memory export", () => {
  test("reads only DM rows from SQLite and splits them into USER.md / MEMORY.md", () => {
    const db = fixtureDb();
    const rows = readDmMemoryRows(db);
    db.close();
    expect(rows.map((r) => r.title).sort()).toEqual([CORE_PROFILE_TITLE, "Coffee preferences", "Reading list", "sushii deploy notes"].sort());

    const out = formatDmMemoryExport(rows);

    expect(out.user).toBe(
      readHomeTemplate("USER.md") +
        "- Lives in Seattle (src: migrated)\n" +
        "- Prefers TypeScript (src: migrated)\n" +
        "- Works nights (src: migrated)\n" +
        "- **Coffee preferences**: Oat milk flat white (src: migrated)\n",
    );
    // Most recently updated first.
    expect(out.memory).toBe(
      readHomeTemplate("MEMORY.md") +
        "- **Reading list**: Dune (src: migrated)\n" +
        "- **sushii deploy notes**: Deploy via ansible; host: apps (src: migrated)\n",
    );
    expect(out.overflow).toEqual([]);
  });

  test("keeps each file within its cap and overflows the rest", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ title: `topic ${i}`, content: "x".repeat(300), updatedAt: 100 - i }));
    const out = formatDmMemoryExport(rows, { userHeader: "# U\n", memoryHeader: "# M\n" });

    expect(out.memory.length).toBeLessThanOrEqual(MEMORY_MD_CAP);
    expect(out.memory.startsWith("# M\n")).toBe(true);
    const kept = out.memory.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(kept + out.overflow.length).toBe(40);
    expect(out.overflow.length).toBeGreaterThan(0);
    expect(out.overflow[0]).toContain(`**topic ${kept}**`);
    expect(out.user).toBe("# U\n");
    expect(formatOverflowFile(out.overflow)).toContain(out.overflow[0]!);
  });
});
