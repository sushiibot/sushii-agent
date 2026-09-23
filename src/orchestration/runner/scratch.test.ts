import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneScratch } from "./piRunner.ts";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pruneScratch", () => {
  test("removes idle scratch folders, keeps fresh and active ones and non-scratch dirs", () => {
    root = mkdtempSync(join(tmpdir(), "scratch-gc-"));
    const old = join(root, "p1", "scratch", "old");
    const active = join(root, "p1", "scratch", "active");
    const fresh = join(root, "p1", "scratch", "fresh");
    const clone = join(root, "p1", "acme-widgets");
    for (const d of [old, active, fresh, clone]) mkdirSync(d, { recursive: true });
    const past = new Date(Date.now() - 48 * 3600_000);
    for (const d of [old, active, clone]) utimesSync(d, past, past);

    expect(pruneScratch(root, 24 * 3600_000, new Set([active]), Date.now())).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(clone)).toBe(true);
  });
});
