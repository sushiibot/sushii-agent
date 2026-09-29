import { join } from "node:path";
import { readJson, writeFileAtomic } from "./files.ts";

/** Bounded, persisted set of recently seen inbound message ids (oldest evicted first). */
export class RecentIds {
  private readonly path: string;
  private ids: string[];
  private readonly set: Set<string>;

  constructor(
    stateDir: string,
    private readonly capacity = 500,
  ) {
    this.path = join(stateDir, "recent-ids.json");
    const loaded = readJson<unknown>(this.path);
    this.ids = Array.isArray(loaded) ? loaded.filter((x): x is string => typeof x === "string").slice(-capacity) : [];
    this.set = new Set(this.ids);
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.ids.push(id);
    this.set.add(id);
    while (this.ids.length > this.capacity) this.set.delete(this.ids.shift()!);
    this.save();
  }

  delete(id: string): void {
    if (!this.set.delete(id)) return;
    this.ids = this.ids.filter((x) => x !== id);
    this.save();
  }

  private save(): void {
    writeFileAtomic(this.path, JSON.stringify(this.ids));
  }
}
