import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historySearchResult, type HistorySearchResult } from "../orchestration/contracts.ts";
import { HistorySearch, buildSnippet, defaultRgPath } from "./historySearch.ts";
import { ulid } from "./ulid.ts";

const RG = defaultRgPath();
const itIfRg = test.skipIf(!RG);
if (!RG) console.warn("ripgrep not found on PATH — skipping history/search tests");

const GH_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
const T0 = Date.parse("2026-09-29T10:00:00Z");

let root: string;
let home: string;
let hist: string;
let search: HistorySearch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-histsearch-"));
  home = join(root, "home");
  hist = join(home, "history");
  mkdirSync(join(hist, "2026-09"), { recursive: true });
  search = new HistorySearch({ principalId: "owner", home });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const find = async (query: string, p: object = {}): Promise<HistorySearchResult> =>
  historySearchResult.parse(await search.search({ principalId: "owner", query, ...p }));

describe("buildSnippet", () => {
  test("cuts around the first match and reports match ranges in code points", () => {
    const line = `${"😀".repeat(100)} the needle and NEEDLE ${"x ".repeat(200)}`;
    const s = buildSnippet(line, "needle")!;
    expect(s.snippet.length).toBeLessThanOrEqual(240);
    const cps = Array.from(s.snippet);
    expect(s.ranges.map(([a, b]) => cps.slice(a, b).join(""))).toEqual(["needle", "NEEDLE"]);
    expect(s.snippet.startsWith("…")).toBe(true);
  });

  test("an uppercase query is case-sensitive (smart case)", () => {
    expect(buildSnippet("needle NEEDLE", "NEEDLE")!.ranges).toEqual([[7, 13]]);
  });

  test("a match that redaction removed is dropped", () => {
    expect(buildSnippet(`token ${GH_TOKEN}`, "A1b2C3")).toBeNull();
    expect(buildSnippet(`token ${GH_TOKEN} and token`, "token")!.snippet).not.toContain(GH_TOKEN);
  });
});

describe("history/search", () => {
  itIfRg("finds daily and run hits with heading, date and runId, newest first", async () => {
    const runId = ulid(T0);
    writeFileSync(join(hist, "2026-09-28.md"), "# 2026-09-28\n\n## Sessions\n\n### 10:00 · new · t · `a.jsonl`\n\nthe zebra crossing\n");
    writeFileSync(join(hist, "2026-09-29.md"), "# 2026-09-29\n\n## Runs\n- zebra run line\n");
    writeFileSync(join(hist, "2026-09", `29-${runId}.md`), `# chat run ${runId}\n\n## Transcript\n\n### user · 10:00\n\nabout a Zebra\n`);
    const r = await find("zebra");
    expect(r.hits.map((h) => [h.id, h.kind, h.date, h.runId ?? null, h.heading ?? null])).toEqual([
      ["2026-09-29.md:4", "daily", "2026-09-29", null, "Runs"],
      [`2026-09/29-${runId}.md:7`, "run", "2026-09-29", runId, "user · 10:00"],
      ["2026-09-28.md:7", "daily", "2026-09-28", null, "10:00 · new · t · `a.jsonl`"],
    ]);
    expect(r).toMatchObject({ before: null, truncated: false });
    expect((await find("zebra", { scope: "runs" })).hits.map((h) => h.kind)).toEqual(["run"]);
    expect((await find("zebra", { scope: "daily" })).hits.map((h) => h.kind)).toEqual(["daily", "daily"]);
    expect((await find("Zebra")).hits).toHaveLength(1);
  });

  itIfRg("pages with `before`", async () => {
    for (let d = 1; d <= 9; d++) writeFileSync(join(hist, `2026-09-0${d}.md`), "needle\n");
    const first = await find("needle", { limit: 4 });
    expect(first.hits.map((h) => h.date)).toEqual(["2026-09-09", "2026-09-08", "2026-09-07", "2026-09-06"]);
    expect(first.before).toBe("2026-09-06.md:1");
    const second = await find("needle", { limit: 4, before: first.before });
    expect(second.hits.map((h) => h.date)).toEqual(["2026-09-05", "2026-09-04", "2026-09-03", "2026-09-02"]);
    const third = await find("needle", { limit: 4, before: second.before });
    expect(third.hits.map((h) => h.date)).toEqual(["2026-09-01"]);
    expect(third.before).toBeNull();
    await expect(search.search({ principalId: "owner", query: "needle", before: "../x.md:1" })).rejects.toThrow(/cursor/);
  });

  itIfRg("hits in symlinks, hardlinks, symlinked month dirs and other names never come back", async () => {
    const secretDir = join(root, "pi-agent");
    mkdirSync(secretDir);
    const auth = join(secretDir, "auth.json");
    writeFileSync(auth, '{"needle":"SECRET_MARKER"}\n');
    linkSync(auth, join(hist, "2026-09-10.md"));
    symlinkSync(auth, join(hist, "2026-09-11.md"));
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, `12-${ulid(T0)}.md`), "needle SECRET_MARKER\n");
    symlinkSync(outside, join(hist, "2026-08"));
    writeFileSync(join(hist, "notes.md"), "needle SECRET_MARKER\n");
    mkdirSync(join(hist, "2026-09", "deep"), { recursive: true });
    writeFileSync(join(hist, "2026-09", "deep", "x.md"), "needle SECRET_MARKER\n");
    writeFileSync(join(hist, "2026-09-13.md"), "needle visible\n");
    const r = await find("needle");
    expect(r.hits.map((h) => h.id)).toEqual(["2026-09-13.md:1"]);
    expect(JSON.stringify(r)).not.toContain("SECRET_MARKER");
  });

  itIfRg("a planted .ignore, .rgignore or rg config hides nothing", async () => {
    writeFileSync(join(hist, ".ignore"), "*.md\n");
    writeFileSync(join(hist, ".rgignore"), "*.md\n");
    writeFileSync(join(hist, ".gitignore"), "*.md\n");
    writeFileSync(join(hist, "2026-09-14.md"), "needle\n");
    expect((await find("needle")).hits).toHaveLength(1);
  });

  itIfRg("a symlinked root returns nothing", async () => {
    rmSync(hist, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "2026-09-15.md"), "needle SECRET_MARKER\n");
    symlinkSync(elsewhere, hist);
    expect(await find("needle")).toEqual({ hits: [], before: null, truncated: false });
  });

  itIfRg("FIFOs, huge files, binary content and huge lines neither hang nor leak", async () => {
    spawnSync("mkfifo", [join(hist, "2026-09-16.md")]);
    writeFileSync(join(hist, "2026-09-17.md"), `${"needle ".repeat(400_000)}\n`);
    writeFileSync(join(hist, "2026-09-18.md"), Buffer.concat([Buffer.from("needle\0binary\n"), Buffer.alloc(100, 0)]));
    writeFileSync(join(hist, "2026-09-19.md"), Buffer.concat([Buffer.from("needle "), Buffer.from([0xff, 0xfe]), Buffer.from(" bad utf8\n")]));
    writeFileSync(join(hist, "2026-09-20.md"), `${"a".repeat(900_000)} needle ${"b".repeat(50_000)}\n`);
    const t = Date.now();
    const r = await find("needle");
    expect(Date.now() - t).toBeLessThan(6_000);
    for (const h of r.hits) expect(h.snippet.length).toBeLessThanOrEqual(240);
    expect(r.hits.map((h) => h.date)).not.toContain("2026-09-17");
    expect(r.hits.map((h) => h.date)).not.toContain("2026-09-16");
    const deep = r.hits.find((h) => h.date === "2026-09-20")!;
    expect(deep.snippet).toBe("…needle [REDACTED]…");
  });

  itIfRg("odd queries: a leading dash, a newline, NUL, regex characters", async () => {
    writeFileSync(join(hist, "2026-09-21.md"), "-v flag and a.*b literal\n");
    expect((await find("-v flag")).hits).toHaveLength(1);
    expect((await find("a.*b")).hits).toHaveLength(1);
    expect(await find("flag\nand")).toEqual({ hits: [], before: null, truncated: false });
    expect(await find("flag\0and")).toEqual({ hits: [], before: null, truncated: false });
  });

  itIfRg("secrets are redacted in snippets and headings", async () => {
    writeFileSync(join(hist, "2026-09-22.md"), `## heading ${GH_TOKEN}\nneedle ${GH_TOKEN}\n`);
    const r = await find("needle");
    expect(r.hits).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(GH_TOKEN);
  });

  itIfRg("a third concurrent search is refused, and a slot frees when one ends", async () => {
    const slow = join(root, "slow-rg");
    writeFileSync(slow, "#!/bin/sh\nsleep 2\n");
    chmodSync(slow, 0o755);
    const s = new HistorySearch({ principalId: "owner", home, rgPath: slow, wallMs: 1_000 });
    const q = { principalId: "owner", query: "needle" };
    const a = s.search(q);
    const b = s.search(q);
    await expect(s.search(q)).rejects.toThrow("busy");
    const t = Date.now();
    expect(await a).toMatchObject({ truncated: true });
    expect(Date.now() - t).toBeLessThan(1_800);
    await b;
    expect(await s.search(q)).toMatchObject({ truncated: true });
  });

  itIfRg("candidates that redaction rejects stop at the read budget and the deadline, and free the slot", async () => {
    // Each line matches for rg but the match sits inside a token that redaction removes, so every candidate is read and rejected.
    const line = `ghp_NEEDLE${"A1b2C3d4".repeat(5)}\n`;
    for (let d = 1; d <= 28; d++) writeFileSync(join(hist, `2026-09-${String(d).padStart(2, "0")}.md`), line.repeat(4_000));
    const budgeted = new HistorySearch({ principalId: "owner", home, readBudget: 300_000 });
    const r = await budgeted.search({ principalId: "owner", query: "NEEDLE" });
    expect(r).toEqual({ hits: [], before: null, truncated: true });
    const late = new HistorySearch({ principalId: "owner", home, deadlineMs: 1 });
    expect(await late.search({ principalId: "owner", query: "NEEDLE" })).toMatchObject({ hits: [], truncated: true });
    writeFileSync(join(hist, "2026-09-30.md"), "plain needle\n");
    expect((await late.search({ principalId: "owner", query: "plain" })).truncated).toBe(true);
    const a = budgeted.search({ principalId: "owner", query: "NEEDLE" });
    const b = budgeted.search({ principalId: "owner", query: "NEEDLE" });
    await Promise.all([a, b]);
    expect((await budgeted.search({ principalId: "owner", query: "plain" })).hits).toHaveLength(1);
  });

  test("checks the principal and needs ripgrep", async () => {
    await expect(search.search({ principalId: "x", query: "needle" })).rejects.toThrow(/principal/);
    const none = new HistorySearch({ principalId: "owner", home, rgPath: null });
    await expect(none.search({ principalId: "owner", query: "needle" })).rejects.toThrow(/ripgrep/);
  });
});
