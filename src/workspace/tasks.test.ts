import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TASK_RULES, type TaskRules } from "./config.ts";
import { runTaskUpkeep } from "./consolidation.ts";
import {
  REVIEW_MAX_ITEMS,
  ageDays,
  applyReviewDecision,
  maintainTasks,
  parseReviewAnswer,
  parseTasksIndex,
  renderTasksCommand,
  renderTasksContext,
  reviewChoices,
  runTaskReview,
  staleEntries,
  type ReviewDecision,
} from "./tasks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-09-29T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const quick = (mark: string, title: string, id: string, updated: string | null, extra = "") =>
  `- [${mark}] ${title} — note (id: ${id})${extra} created:2026-09-01${updated ? ` updated:${updated}` : ""}`;

function home(tasks: string, projects: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "ws-tasks-"));
  dirs.push(d);
  writeFileSync(join(d, "TASKS.md"), tasks);
  mkdirSync(join(d, "tasks", "archive"), { recursive: true });
  for (const [slug, body] of Object.entries(projects)) writeFileSync(join(d, "tasks", `${slug}.md`), body);
  return d;
}

const index = (quickLines: string[], projectLines: string[] = []) => ["# TASKS.md", "", "## Quick", ...quickLines, "", "## Projects", ...projectLines, ""].join("\n");
const project = (status: string, updated: string, subtasks: string[] = []) => ["# Project", `status: ${status}`, `updated: ${updated}`, "", ...subtasks, ""].join("\n");
const read = (h: string, rel = "TASKS.md") => readFileSync(join(h, rel), "utf8");

describe("parsing and staleness", () => {
  test("quick items, states, sizes and project lines with the later of the two dates", () => {
    const h = home("", { osaka: project("active", daysAgo(1)) });
    const text = index(
      [quick(" ", "Book dentist", "t-a1", daysAgo(1)), quick("x", "Pay rent", "t-b2", daysAgo(2)), quick("-", "Old idea", "t-c3", null, " size:project")],
      [`- Osaka trip — hotels next (updated:${daysAgo(5)}) → tasks/osaka.md`],
    );
    const idx = parseTasksIndex(text, h);
    expect(idx.quick.map((q) => [q.title, q.state, q.id, q.size, q.updated ?? null])).toEqual([
      ["Book dentist", "open", "t-a1", "quick", daysAgo(1)],
      ["Pay rent", "done", "t-b2", "quick", daysAgo(2)],
      ["Old idea", "dropped", "t-c3", "project", null],
    ]);
    expect(idx.projects).toEqual([{ line: 8, name: "Osaka trip", slug: "osaka", updated: daysAgo(1), status: "active" }]);
  });

  test("missing or unparseable dates count as stale; quick and project thresholds differ", () => {
    expect(ageDays(undefined, NOW)).toBe(Number.POSITIVE_INFINITY);
    const h = home(
      index(
        [quick(" ", "Fresh", "t-1", daysAgo(2)), quick(" ", "Stale quick", "t-2", daysAgo(3)), quick(" ", "No date", "t-3", null), quick(" ", "Bad date", "t-4", "2026-13-45"), quick(" ", "Long one", "t-5", daysAgo(5), " size:project")],
        [`- Trip — x (updated:${daysAgo(8)}) → tasks/trip.md`, `- Blog — x (updated:${daysAgo(7)}) → tasks/blog.md`],
      ),
    );
    expect(staleEntries(h, DEFAULT_TASK_RULES, NOW).map((e) => [e.title, e.kind])).toEqual([
      ["Stale quick", "quick"],
      ["No date", "quick"],
      ["Bad date", "quick"],
      ["Trip", "project"],
    ]);
  });
});

describe("the loaded context copy", () => {
  test("stale entries are marked, done ones stay while there's room", () => {
    const text = index([quick(" ", "Stale", "t-1", daysAgo(4)), quick(" ", "Fresh", "t-2", daysAgo(0)), quick("x", "Done", "t-3", daysAgo(1))], [`- Trip — next (updated:${daysAgo(9)}) → tasks/trip.md`]);
    const out = renderTasksContext(text, { now: NOW });
    expect(out).toContain(`${quick(" ", "Stale", "t-1", daysAgo(4))} (stale 4d)`);
    expect(out).toContain(`${quick(" ", "Fresh", "t-2", daysAgo(0))}\n`);
    expect(out).toContain("(stale 9d)");
    expect(out).toContain("Done");
    expect(out).not.toContain("⚠");
  });

  test("over the cap, done and dropped lines go first and open ones stay; over the open cap, a warning leads", () => {
    const rules: TaskRules = { ...DEFAULT_TASK_RULES, maxOpen: 2 };
    const done = Array.from({ length: 40 }, (_, i) => quick("x", `Done ${i} ${"x".repeat(40)}`, `t-d${i}`, daysAgo(1)));
    const open = [quick(" ", "Open A", "t-oa", daysAgo(0)), quick(" ", "Open B", "t-ob", daysAgo(0)), quick(" ", "Open C", "t-oc", daysAgo(0))];
    const out = renderTasksContext(index([...done, ...open]), { now: NOW, rules });
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out).not.toContain("Done 0");
    for (const t of ["Open A", "Open B", "Open C"]) expect(out).toContain(t);
    expect(out.split("\n")[0]).toBe("> ⚠ 3 open entries (cap 2): prune TASKS.md before adding anything.");
  });

  test("a file too big even without its closed items is cut with a note", () => {
    const open = Array.from({ length: 60 }, (_, i) => quick(" ", `Open ${i} ${"y".repeat(60)}`, `t-o${i}`, daysAgo(0)));
    const out = renderTasksContext(index(open), { now: NOW, rules: { ...DEFAULT_TASK_RULES, maxOpen: 100 } });
    expect(out).toContain("[TASKS.md truncated at 3000 chars — prune it]");
  });
});

describe("stale review", () => {
  test("answers: buttons, free text, all; anything else is not an answer", () => {
    expect(parseReviewAnswer("Keep all", 3)).toEqual([0, 1, 2].map((index) => ({ index, decision: "keep" })));
    expect(parseReviewAnswer("drop 2", 3)).toEqual([{ index: 1, decision: "drop" }]);
    expect(parseReviewAnswer("keep 1 3, drop 2", 3)).toEqual([
      { index: 0, decision: "keep" },
      { index: 2, decision: "keep" },
      { index: 1, decision: "drop" },
    ]);
    expect(parseReviewAnswer("drop 4", 3)).toBeNull();
    expect(parseReviewAnswer("keep going with the plan", 3)).toBeNull();
    expect(reviewChoices(2)).toEqual(["Keep all", "Drop all", "Keep 1", "Drop 1", "Keep 2", "Drop 2"]);
    expect(reviewChoices(REVIEW_MAX_ITEMS).length).toBeLessThanOrEqual(25);
  });

  test("keep bumps updated; drop marks a quick item dropped and archives a project", () => {
    const h = home(index([quick(" ", "A", "t-a", daysAgo(4)), quick(" ", "B", "t-b", daysAgo(4))], [`- Trip — next (updated:${daysAgo(9)}) → tasks/trip.md`]), {
      trip: project("active", daysAgo(9)),
    });
    const [a, b, trip] = staleEntries(h, DEFAULT_TASK_RULES, NOW);
    expect(applyReviewDecision(h, a!, "keep", NOW)).toBe(true);
    expect(applyReviewDecision(h, b!, "drop", NOW)).toBe(true);
    expect(applyReviewDecision(h, trip!, "drop", NOW)).toBe(true);
    const text = read(h);
    expect(text).toContain(`- [ ] A — note (id: t-a) created:2026-09-01 updated:${daysAgo(0)}`);
    expect(text).toContain(`- [-] B — note (id: t-b) created:2026-09-01 updated:${daysAgo(0)} (dropped via review)`);
    expect(text).not.toContain("tasks/trip.md");
    expect(existsSync(join(h, "tasks", "archive", "trip.md"))).toBe(true);
    expect(staleEntries(h, DEFAULT_TASK_RULES, NOW)).toEqual([]);
  });

  test("once a day, only with stale entries, within the proactive limit; the answer is applied and committed", async () => {
    const h = home(index([quick(" ", "A", "t-a", daysAgo(4)), quick(" ", "B", "t-b", daysAgo(4))]));
    const stateDir = join(h, ".state");
    let allow = true;
    const recorded: Date[] = [];
    const asks: Array<{ question: string; choices: string[]; parse: (t: string) => { value: ReviewDecision[] } | null }> = [];
    let answer: (v: ReviewDecision[] | undefined) => void = () => {};
    const writes: string[] = [];
    const deps = {
      home: h,
      stateDir,
      rules: DEFAULT_TASK_RULES,
      allow: () => allow,
      record: (d: Date) => recorded.push(d),
      ask: (question: string, choices: string[], parse: (t: string) => { value: ReviewDecision[] } | null) => {
        asks.push({ question, choices, parse });
        return new Promise<ReviewDecision[] | undefined>((r) => (answer = r));
      },
      write: async (fn: () => void, message: string) => {
        fn();
        writes.push(message);
      },
      now: () => NOW,
    };
    allow = false;
    expect(await runTaskReview(deps)).toBe("rate_limited");
    allow = true;
    expect(await runTaskReview(deps)).toBe("sent");
    expect(recorded).toHaveLength(1);
    expect(asks[0]!.question).toContain("1. A (stale 4d)");
    expect(asks[0]!.choices.slice(0, 4)).toEqual(["Keep all", "Drop all", "Keep 1", "Drop 1"]);
    expect(asks[0]!.parse("Drop 2")?.value).toEqual([{ index: 1, decision: "drop" }]);
    expect(await runTaskReview(deps)).toBe("done_today");

    answer([
      { index: 0, decision: "keep" },
      { index: 1, decision: "drop" },
    ]);
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toEqual(["chore(tasks): stale review"]);
    expect(read(h)).toContain("(dropped via review)");
    expect(staleEntries(h, DEFAULT_TASK_RULES, NOW)).toEqual([]);

    const fresh = home(index([quick(" ", "A", "t-a", daysAgo(0))]));
    expect(await runTaskReview({ ...deps, home: fresh, stateDir: join(fresh, ".state") })).toBe("none");
  });
});

describe("nightly upkeep", () => {
  test("auto-drops stale quick items and archives stale or finished projects", () => {
    const h = home(
      index(
        [quick(" ", "Quick old", "t-1", daysAgo(6)), quick(" ", "Quick ok", "t-2", daysAgo(5)), quick(" ", "Tagged project", "t-3", daysAgo(10), " size:project")],
        [`- Old — x (updated:${daysAgo(30)}) → tasks/old.md`, `- Kept — x (updated:${daysAgo(30)}) → tasks/kept.md`, `- Done — x (updated:${daysAgo(1)}) → tasks/done.md`],
      ),
      { old: project("active", daysAgo(22)), kept: project("active", daysAgo(20)), done: project("done", daysAgo(1)) },
    );
    const res = maintainTasks(h, DEFAULT_TASK_RULES, NOW);
    const text = read(h);
    expect(text).toContain(`- [-] Quick old — note (id: t-1) created:2026-09-01 updated:${daysAgo(0)} (auto: stale)`);
    expect(text).toContain("- [ ] Quick ok");
    expect(text).toContain("- [ ] Tagged project");
    expect(text).not.toContain("tasks/old.md");
    expect(text).toContain("tasks/kept.md");
    expect(text).not.toContain("tasks/done.md");
    expect(existsSync(join(h, "tasks", "archive", "old.md"))).toBe(true);
    expect(existsSync(join(h, "tasks", "archive", "done.md"))).toBe(true);
    expect(existsSync(join(h, "tasks", "kept.md"))).toBe(true);
    expect(res.changed).toBe(true);
  });

  test("over the open cap, the oldest-untouched quick items go first; with only projects left it flags", () => {
    const rules: TaskRules = { ...DEFAULT_TASK_RULES, maxOpen: 3 };
    const h = home(index([quick(" ", "Newest", "t-1", daysAgo(0)), quick(" ", "Oldest", "t-2", daysAgo(2)), quick(" ", "Middle", "t-3", daysAgo(1))], [`- P — x (updated:${daysAgo(0)}) → tasks/p.md`, `- Q — x (updated:${daysAgo(0)}) → tasks/q.md`]), {
      p: project("active", daysAgo(0)),
      q: project("active", daysAgo(0)),
    });
    const res = maintainTasks(h, rules, NOW);
    const text = read(h);
    expect(text).toContain("- [-] Oldest");
    expect(text).toContain("- [-] Middle");
    expect(text).toContain("- [ ] Newest");
    expect(res.overCap).toBe(false);

    const onlyProjects = home(index([], [`- P — x (updated:${daysAgo(0)}) → tasks/p.md`, `- Q — x (updated:${daysAgo(0)}) → tasks/q.md`]), { p: project("active", daysAgo(0)), q: project("active", daysAgo(0)) });
    const flagged = maintainTasks(onlyProjects, { ...DEFAULT_TASK_RULES, maxOpen: 1 }, NOW);
    expect(flagged.overCap).toBe(true);
    expect(read(onlyProjects)).toContain("tasks/q.md");
  });

  test("prunes done/dropped quick items and dated done sub-tasks older than 7 days", () => {
    const h = home(index([quick("x", "Old done", "t-1", daysAgo(8)), quick("-", "Old dropped", "t-2", daysAgo(9)), quick("x", "Recent done", "t-3", daysAgo(3))], [`- P — x (updated:${daysAgo(0)}) → tasks/p.md`]), {
      p: project("active", daysAgo(0), [`- [x] old step updated:${daysAgo(8)}`, `- [x] recent step updated:${daysAgo(2)}`, "- [x] undated step", "- [ ] open step"]),
    });
    maintainTasks(h, DEFAULT_TASK_RULES, NOW);
    const text = read(h);
    expect(text).not.toContain("Old done");
    expect(text).not.toContain("Old dropped");
    expect(text).toContain("Recent done");
    const p = read(h, "tasks/p.md");
    expect(p).not.toContain("old step");
    for (const s of ["recent step", "undated step", "open step"]) expect(p).toContain(s);
  });

  test("the consolidation job's upkeep commits the task paths", async () => {
    const h = home(index([quick(" ", "Stale", "t-1", daysAgo(9))]));
    const commits: Array<[string, string[]]> = [];
    const summary = await runTaskUpkeep({ home: h, rules: DEFAULT_TASK_RULES, now: NOW, commit: async (m, p) => commits.push([m, p]) });
    expect(summary).toBe("tasks: 1 change");
    expect(commits).toEqual([["chore(tasks): nightly upkeep", ["TASKS.md", "tasks/"]]]);
    expect(await runTaskUpkeep({ home: h, rules: DEFAULT_TASK_RULES, now: NOW, commit: async (m, p) => commits.push([m, p]) })).toBeNull();
  });

  test("the upkeep waits for the chat session to be idle, and defers when it stays busy", async () => {
    const h = home(index([quick(" ", "Stale", "t-1", daysAgo(9))]));
    const before = read(h);
    const live = { isIdle: () => false, requestContextReload: () => {} };
    expect(await runTaskUpkeep({ home: h, rules: DEFAULT_TASK_RULES, now: NOW, commit: async () => {}, live, idleWaitMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })).toBeNull();
    expect(read(h)).toBe(before);
    let idle = false;
    setTimeout(() => (idle = true), 10);
    let reloads = 0;
    const summary = await runTaskUpkeep({ home: h, rules: DEFAULT_TASK_RULES, now: NOW, commit: async () => {}, live: { isIdle: () => idle, requestContextReload: () => reloads++ }, idleWaitMs: 5000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    expect(summary).toBe("tasks: 1 change");
    expect(reloads).toBe(1);
  });
});

describe("!tasks", () => {
  test("the index shows open entries only, with stale marks; a project shows its open sub-tasks", () => {
    const h = home(index([quick(" ", "Book dentist", "t-1", daysAgo(3)), quick("x", "Pay rent", "t-2", daysAgo(0))], [`- Osaka trip — hotels next (updated:${daysAgo(0)}) → tasks/osaka-trip.md`]), {
      "osaka-trip": project("active", daysAgo(0), ["- [x] flights", "- [ ] hotels", "- [ ] rail pass"]),
    });
    const out = renderTasksCommand(h, DEFAULT_TASK_RULES, NOW);
    expect(out).toBe(
      [
        "**Quick**",
        `- Book dentist — note (id: t-1) created:2026-09-01 updated:${daysAgo(3)} _(stale 3d)_`,
        "",
        "**Projects**",
        `- Osaka trip — hotels next (updated:${daysAgo(0)}) → tasks/osaka-trip.md`,
      ].join("\n"),
    );
    for (const arg of ["osaka-trip", "Osaka trip", "osaka"]) {
      expect(renderTasksCommand(h, DEFAULT_TASK_RULES, NOW, arg)).toBe(`**Osaka trip** (\`tasks/osaka-trip.md\`, active, updated ${daysAgo(0)})\n- [ ] hotels\n- [ ] rail pass`);
    }
    expect(renderTasksCommand(h, DEFAULT_TASK_RULES, NOW, "tokyo")).toBe('No project matching "tokyo". Projects: `osaka-trip`.');
    expect(renderTasksCommand(home(index([])), DEFAULT_TASK_RULES, NOW)).toBe("No open tasks.");
  });
});
