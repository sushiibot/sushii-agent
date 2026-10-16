import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeFeedback } from "./feedback.ts";
import { CLEANUP_RETENTION_MS } from "./db/retention.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("feedback cleanup removes expired files and legacy transcripts without touching unrelated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-retention-"));
  dirs.push(dir);
  const now = Date.now();
  writeFileSync(join(dir, "feedback-old.json"), JSON.stringify({ timestamp: new Date(now - CLEANUP_RETENTION_MS).toISOString() }));
  writeFileSync(join(dir, "feedback-new.json"), JSON.stringify({ timestamp: new Date(now).toISOString(), feedback: "useful", conversation: ["private"] }));
  writeFileSync(join(dir, "feedback-corrupt.json"), "invalid");
  writeFileSync(join(dir, "unrelated.json"), "keep");
  purgeFeedback(dir, now);
  expect(readdirSync(dir).sort()).toEqual(["feedback-new.json", "unrelated.json"]);
  expect(JSON.parse(readFileSync(join(dir, "feedback-new.json"), "utf8"))).toEqual({ timestamp: new Date(now).toISOString(), feedback: "useful" });
});
