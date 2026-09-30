import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TASK_RULES, type TaskRules } from "./config.ts";
import { readJson, writeFileAtomic } from "./files.ts";

// No logger import: consolidation's CLI loads this module and pino would write JSON onto its stdout.

export const TASKS_FILE = "TASKS.md";
export const TASKS_DIR = "tasks";
export const TASKS_ARCHIVE_DIR = "tasks/archive";
/** Paths the workspace commits for task upkeep. */
export const TASK_PATHS = [TASKS_FILE, `${TASKS_DIR}/`];
/** The loaded copy of TASKS.md is capped at this many chars. */
export const TASKS_CONTEXT_CAP = 3000;
/** Done and dropped entries are pruned this many days after their last update. */
export const TASK_PRUNE_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKBOX = /^(\s*-\s*\[)([ xX-])(\]\s+)(.*)$/;
const PROJECT_LINK = /(?:→|->)\s*tasks\/([a-z0-9][a-z0-9._-]*)\.md/i;

export type TaskState = "open" | "done" | "dropped";
export type TaskSize = "quick" | "project";

export interface QuickItem {
  /** Index into the file's lines. */
  line: number;
  state: TaskState;
  title: string;
  id?: string;
  size: TaskSize;
  updated?: string;
}

export interface ProjectEntry {
  line: number;
  name: string;
  slug: string;
  /** The later of the index line's and the project file's `updated`. */
  updated?: string;
  /** The project file's `status:`; "active" when missing. */
  status: string;
}

export interface TasksIndex {
  lines: string[];
  quick: QuickItem[];
  projects: ProjectEntry[];
}

const tag = (text: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|[\\s(])${name}:\\s*(\\S+?)(?=[\\s),\\]]|$)`, "i").exec(text);
  return m?.[1];
};

function dateTag(text: string, name: string): string | undefined {
  const v = tag(text, name);
  return v && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined;
}

function laterDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whole days since `date`; missing or unparseable dates are infinitely old. */
export function ageDays(date: string | undefined, now: Date): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

function titleOf(body: string): string {
  const cut = body.split(/\s+—\s+|\s+\(id:|\s+(?:size|created|updated):/i)[0] ?? body;
  return cut.trim() || body.trim();
}

function projectHeader(home: string, slug: string): { updated?: string; status: string } {
  let text: string;
  try {
    text = readFileSync(join(home, TASKS_DIR, `${slug}.md`), "utf8");
  } catch {
    return { status: "active" };
  }
  const updated = /^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(text)?.[1];
  const status = /^status:\s*(\w+)/im.exec(text)?.[1]?.toLowerCase() ?? "active";
  return { ...(updated ? { updated } : {}), status };
}

/** Parses TASKS.md: checkbox lines are quick items; `→ tasks/<slug>.md` lines under `## Projects` are projects. */
export function parseTasksIndex(text: string, home?: string): TasksIndex {
  const lines = text.split("\n");
  const quick: QuickItem[] = [];
  const projects: ProjectEntry[] = [];
  let section: "quick" | "projects" | null = null;
  lines.forEach((raw, i) => {
    const heading = /^##\s+(.*)$/.exec(raw);
    if (heading) {
      const name = heading[1]!.trim().toLowerCase();
      section = name.startsWith("quick") ? "quick" : name.startsWith("project") ? "projects" : null;
      return;
    }
    const box = CHECKBOX.exec(raw);
    if (box && section !== "projects") {
      const mark = box[2]!.toLowerCase();
      const body = box[4]!;
      const id = /\(id:\s*(t-[a-z0-9-]+)\)/i.exec(body)?.[1]?.toLowerCase() ?? tag(body, "id")?.toLowerCase();
      const size = tag(body, "size")?.toLowerCase() === "project" ? "project" : "quick";
      const updated = dateTag(body, "updated");
      quick.push({
        line: i,
        state: mark === "x" ? "done" : mark === "-" ? "dropped" : "open",
        title: titleOf(body),
        ...(id ? { id } : {}),
        size,
        ...(updated ? { updated } : {}),
      });
      return;
    }
    const link = PROJECT_LINK.exec(raw);
    if (link && section === "projects" && /^\s*-\s+/.test(raw)) {
      const slug = link[1]!.toLowerCase();
      const name = raw.replace(/^\s*-\s+/, "").split(/\s+—\s+|\s+(?:→|->)/)[0]!.trim();
      const header = home ? projectHeader(home, slug) : { status: "active" };
      const updated = laterDate(dateTag(raw, "updated"), header.updated);
      projects.push({ line: i, name, slug, ...(updated ? { updated } : {}), status: header.status });
    }
  });
  return { lines, quick, projects };
}

function staleAfter(rules: TaskRules, size: TaskSize): number {
  return size === "project" ? rules.staleDaysProject : rules.staleDaysQuick;
}

function dropAfter(rules: TaskRules, size: TaskSize): number {
  return size === "project" ? rules.autodropDaysProject : rules.autodropDaysQuick;
}

export function readTasks(home: string): string | null {
  try {
    return readFileSync(join(home, TASKS_FILE), "utf8");
  } catch {
    return null;
  }
}

export function openCount(index: TasksIndex): number {
  return index.quick.filter((q) => q.state === "open").length + index.projects.length;
}

/**
 * TASKS.md as loaded into the main session: stale open entries marked `(stale Nd)`, a warning line when
 * over the open cap, and on overflow the done/dropped lines go first, then the tail is cut.
 */
export function renderTasksContext(text: string, opts: { home?: string; rules?: TaskRules; now?: Date; cap?: number } = {}): string {
  const rules = opts.rules ?? DEFAULT_TASK_RULES;
  const now = opts.now ?? new Date();
  const cap = opts.cap ?? TASKS_CONTEXT_CAP;
  const index = parseTasksIndex(text, opts.home);
  const lines = [...index.lines];
  const closed = new Set<number>();
  for (const q of index.quick) {
    if (q.state !== "open") {
      closed.add(q.line);
      continue;
    }
    const age = ageDays(q.updated, now);
    if (age > staleAfter(rules, q.size)) lines[q.line] = `${lines[q.line]} (stale ${Number.isFinite(age) ? `${age}d` : "no date"})`;
  }
  for (const p of index.projects) {
    const age = ageDays(p.updated, now);
    if (age > rules.staleDaysProject) lines[p.line] = `${lines[p.line]} (stale ${Number.isFinite(age) ? `${age}d` : "no date"})`;
  }
  const open = openCount(index);
  const warning = open > rules.maxOpen ? [`> ⚠ ${open} open entries (cap ${rules.maxOpen}): prune TASKS.md before adding anything.`, ""] : [];
  let out = [...warning, ...lines].join("\n");
  if (out.length > cap) out = [...warning, ...lines.filter((_, i) => !closed.has(i))].join("\n");
  if (out.length > cap) out = `${out.slice(0, cap)}\n[TASKS.md truncated at ${cap} chars — prune it]\n`;
  return out;
}

export interface StaleEntry {
  kind: "quick" | "project";
  /** Quick item id, else its exact line; project slug. */
  key: string;
  title: string;
  days: number;
}

/** Open quick items and projects past their staleness age. */
export function staleEntries(home: string, rules: TaskRules, now: Date): StaleEntry[] {
  const text = readTasks(home);
  if (text === null) return [];
  const index = parseTasksIndex(text, home);
  const out: StaleEntry[] = [];
  for (const q of index.quick) {
    if (q.state !== "open") continue;
    const days = ageDays(q.updated, now);
    if (days > staleAfter(rules, q.size)) out.push({ kind: "quick", key: q.id ?? index.lines[q.line]!, title: q.title, days });
  }
  for (const p of index.projects) {
    const days = ageDays(p.updated, now);
    if (days > rules.staleDaysProject) out.push({ kind: "project", key: p.slug, title: p.name, days });
  }
  return out;
}

function setUpdated(line: string, date: string): string {
  return /(^|[\s(])updated:\s*\S+?(?=[\s),\]]|$)/i.test(line)
    ? line.replace(/((?:^|[\s(])updated:)\s*\S+?(?=[\s),\]]|$)/i, `$1${date}`)
    : `${line} updated:${date}`;
}

function markDropped(line: string, reason: string, date: string): string {
  return setUpdated(line.replace(CHECKBOX, (_m, a, _b, c, d) => `${a}-${c}${d} (${reason})`), date);
}

function projectPath(home: string, slug: string): string {
  return join(home, TASKS_DIR, `${slug}.md`);
}

function bumpProjectFile(home: string, slug: string, date: string): void {
  const path = projectPath(home, slug);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const next = /^updated:.*$/im.test(text) ? text.replace(/^updated:.*$/im, `updated: ${date}`) : `updated: ${date}\n${text}`;
  writeFileAtomic(path, next);
}

/** Moves tasks/<slug>.md into the archive (never overwriting an archived file). */
function archiveProjectFile(home: string, slug: string, date: string): void {
  const from = projectPath(home, slug);
  if (!existsSync(from)) return;
  mkdirSync(join(home, TASKS_ARCHIVE_DIR), { recursive: true });
  let to = join(home, TASKS_ARCHIVE_DIR, `${slug}.md`);
  if (existsSync(to)) to = join(home, TASKS_ARCHIVE_DIR, `${slug}-${date}.md`);
  renameSync(from, to);
}

function findQuick(index: TasksIndex, key: string): QuickItem | undefined {
  return index.quick.find((q) => q.state === "open" && (q.id === key || index.lines[q.line] === key));
}

/** Applies a stale-review answer: keep bumps `updated`; drop marks a quick item `[-]` or archives a project. */
export function applyReviewDecision(home: string, entry: StaleEntry, decision: "keep" | "drop", now: Date): boolean {
  const text = readTasks(home);
  if (text === null) return false;
  const index = parseTasksIndex(text, home);
  const date = today(now);
  if (entry.kind === "quick") {
    const q = findQuick(index, entry.key);
    if (!q) return false;
    index.lines[q.line] = decision === "keep" ? setUpdated(index.lines[q.line]!, date) : markDropped(index.lines[q.line]!, "dropped via review", date);
  } else {
    const p = index.projects.find((x) => x.slug === entry.key);
    if (!p) return false;
    if (decision === "keep") {
      index.lines[p.line] = setUpdated(index.lines[p.line]!, date);
      bumpProjectFile(home, p.slug, date);
    } else {
      archiveProjectFile(home, p.slug, date);
      index.lines.splice(p.line, 1);
    }
  }
  writeFileAtomic(join(home, TASKS_FILE), index.lines.join("\n"));
  return true;
}

export interface MaintenanceResult {
  changed: boolean;
  actions: string[];
  /** Still over the open cap with only projects left to drop. */
  overCap: boolean;
}

/**
 * The nightly, deterministic upkeep: auto-drop stale quick items, archive stale or finished projects, drop the
 * oldest quick items over the open cap, and prune done/dropped entries (and dated done sub-tasks) past
 * TASK_PRUNE_DAYS.
 */
export function maintainTasks(home: string, rules: TaskRules, now: Date): MaintenanceResult {
  const text = readTasks(home);
  const actions: string[] = [];
  if (text === null) return { changed: false, actions, overCap: false };
  const date = today(now);
  const index = parseTasksIndex(text, home);
  const lines: Array<string | null> = [...index.lines];

  for (const q of index.quick) {
    if (q.state !== "open" || ageDays(q.updated, now) <= dropAfter(rules, q.size)) continue;
    lines[q.line] = markDropped(lines[q.line]!, "auto: stale", date);
    q.state = "dropped";
    q.updated = date;
    actions.push(`auto-dropped stale "${q.title}"`);
  }
  const live: ProjectEntry[] = [];
  for (const p of index.projects) {
    const finished = p.status === "done" || p.status === "dropped";
    if (!finished && ageDays(p.updated, now) <= rules.autodropDaysProject) {
      live.push(p);
      continue;
    }
    archiveProjectFile(home, p.slug, date);
    lines[p.line] = null;
    actions.push(`archived ${finished ? p.status : "stale"} project ${p.slug}`);
  }
  const openQuick = index.quick.filter((q) => q.state === "open").sort((a, b) => (a.updated ?? "").localeCompare(b.updated ?? ""));
  let open = openQuick.length + live.length;
  for (const q of openQuick) {
    if (open <= rules.maxOpen) break;
    lines[q.line] = markDropped(lines[q.line]!, "auto: over cap", date);
    q.state = "dropped";
    q.updated = date;
    open--;
    actions.push(`dropped "${q.title}" (over the open cap)`);
  }
  for (const q of index.quick) {
    if (q.state === "open" || lines[q.line] === null) continue;
    if (ageDays(q.updated, now) > TASK_PRUNE_DAYS) {
      lines[q.line] = null;
      actions.push(`pruned ${q.state} "${q.title}"`);
    }
  }
  const next = lines.filter((l): l is string => l !== null).join("\n");
  if (next !== text) writeFileAtomic(join(home, TASKS_FILE), next);

  for (const p of live) {
    const path = projectPath(home, p.slug);
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const kept = body.split("\n").filter((l) => {
      const box = CHECKBOX.exec(l);
      if (!box || box[2] === " ") return true;
      const done = dateTag(box[4]!, "updated");
      return !(done && ageDays(done, now) > TASK_PRUNE_DAYS);
    });
    if (kept.join("\n") !== body) {
      writeFileAtomic(path, kept.join("\n"));
      actions.push(`pruned old done sub-tasks in tasks/${p.slug}.md`);
    }
  }
  return { changed: actions.length > 0, actions, overCap: open > rules.maxOpen };
}

/** `!tasks`: the open index entries; `!tasks <project>`: that project's open sub-tasks. No model involved. */
export function renderTasksCommand(home: string, rules: TaskRules, now: Date, arg?: string): string {
  const text = readTasks(home);
  if (text === null) return "No TASKS.md yet.";
  const index = parseTasksIndex(text, home);
  const stale = (updated: string | undefined, after: number) => {
    const age = ageDays(updated, now);
    return age > after ? ` _(stale ${Number.isFinite(age) ? `${age}d` : "no date"})_` : "";
  };
  if (arg?.trim()) {
    const want = arg.trim().toLowerCase();
    const p =
      index.projects.find((x) => x.slug === want || x.name.toLowerCase() === want) ??
      index.projects.find((x) => x.slug.includes(want.replace(/\s+/g, "-")) || x.name.toLowerCase().includes(want));
    if (!p) return `No project matching "${arg.trim()}". Projects: ${index.projects.map((x) => `\`${x.slug}\``).join(", ") || "none"}.`;
    let body: string;
    try {
      body = readFileSync(projectPath(home, p.slug), "utf8");
    } catch {
      return `**${p.name}** — tasks/${p.slug}.md is missing.`;
    }
    const open = body.split("\n").filter((l) => CHECKBOX.exec(l)?.[2] === " ").map((l) => l.trim());
    return [`**${p.name}** (\`tasks/${p.slug}.md\`, ${p.status}${p.updated ? `, updated ${p.updated}` : ""})${stale(p.updated, rules.staleDaysProject)}`, ...(open.length ? open : ["No open sub-tasks."])].join("\n");
  }
  const quick = index.quick.filter((q) => q.state === "open").map((q) => `- ${index.lines[q.line]!.replace(CHECKBOX, "$4").trim()}${stale(q.updated, staleAfter(rules, q.size))}`);
  const projects = index.projects.map((p) => `- ${index.lines[p.line]!.replace(/^\s*-\s+/, "").trim()}${stale(p.updated, rules.staleDaysProject)}`);
  if (!quick.length && !projects.length) return "No open tasks.";
  const open = openCount(index);
  return [
    ...(quick.length ? ["**Quick**", ...quick] : []),
    ...(projects.length ? [...(quick.length ? [""] : []), "**Projects**", ...projects] : []),
    ...(open > rules.maxOpen ? ["", `-# ${open} open entries, over the cap of ${rules.maxOpen}`] : []),
  ].join("\n");
}

// ── The daily stale review, run from the heartbeat. ──

export interface ReviewDecision {
  index: number;
  decision: "keep" | "drop";
}

/** Button labels and replies like "keep all", "drop 2", "keep 1 3, drop 2"; null when it isn't a review answer. */
export function parseReviewAnswer(text: string, count: number): ReviewDecision[] | null {
  const input = text.trim().toLowerCase();
  if (!/^(?:(?:keep|drop)\s+(?:all|\d+(?:\s*(?:,|and|\s)\s*\d+)*)[\s,;.]*)+$/.test(input)) return null;
  const out = new Map<number, "keep" | "drop">();
  for (const m of input.matchAll(/(keep|drop)\s+(all|\d+(?:\s*(?:,|and|\s)\s*\d+)*)/g)) {
    const decision = m[1] as "keep" | "drop";
    const targets = m[2] === "all" ? Array.from({ length: count }, (_, i) => i + 1) : m[2]!.split(/\s*(?:,|and|\s)\s*/).filter(Boolean).map(Number);
    for (const n of targets) {
      if (!Number.isInteger(n) || n < 1 || n > count) return null;
      out.set(n - 1, decision);
    }
  }
  return out.size ? [...out].map(([index, decision]) => ({ index, decision })) : null;
}

export const REVIEW_MAX_ITEMS = 10;
export const REVIEW_JOB = "task-review";

export function reviewQuestion(items: StaleEntry[], more: number): string {
  const lines = items.map((e, i) => `${i + 1}. ${e.kind === "project" ? "Project: " : ""}${e.title} (stale ${Number.isFinite(e.days) ? `${e.days}d` : "no date"})`);
  return [
    "These TASKS.md entries haven't moved lately. Keep or drop?",
    ...lines,
    ...(more > 0 ? [`…and ${more} more; they come up in a later review.`] : []),
    "Or reply e.g. `keep 1 3, drop 2`.",
  ].join("\n");
}

export function reviewChoices(count: number): string[] {
  return ["Keep all", "Drop all", ...Array.from({ length: count }, (_, i) => [`Keep ${i + 1}`, `Drop ${i + 1}`]).flat()];
}

export interface TaskReviewDeps {
  home: string;
  stateDir: string;
  rules: TaskRules;
  /** Rate limit shared with the proactive jobs; false when no proactive message may go out now. */
  allow(now: Date): boolean;
  /** Counts the review against the proactive limits. */
  record(now: Date): void;
  /** Sends the ask to drk; resolves to the answer, or undefined when it expired. */
  ask(question: string, choices: string[], parse: (text: string) => { value: ReviewDecision[] } | null): Promise<ReviewDecision[] | undefined>;
  /** Wraps the file edits (e.g. the subagents' protected-file lease) and commits them. */
  write(fn: () => void, message: string): Promise<void>;
  now?: () => Date;
  warn?: (obj: object, msg: string) => void;
}

interface ReviewState {
  lastReviewDate?: string;
}

/**
 * At most once per day: if any TASKS.md entries are stale, one ask lists them with Keep/Drop. The answer is
 * applied to the files in code and committed. Returns once the ask is sent; the answer is handled later.
 */
export async function runTaskReview(deps: TaskReviewDeps): Promise<"sent" | "none" | "done_today" | "rate_limited"> {
  const now = deps.now?.() ?? new Date();
  const statePath = join(deps.stateDir, "task-review.json");
  const state = readJson<ReviewState>(statePath) ?? {};
  const day = today(now);
  if (state.lastReviewDate === day) return "done_today";
  const stale = staleEntries(deps.home, deps.rules, now);
  if (!stale.length) {
    writeFileAtomic(statePath, `${JSON.stringify({ lastReviewDate: day }, null, 2)}\n`);
    return "none";
  }
  if (!deps.allow(now)) return "rate_limited";
  const items = stale.slice(0, REVIEW_MAX_ITEMS);
  deps.record(now);
  writeFileAtomic(statePath, `${JSON.stringify({ lastReviewDate: day }, null, 2)}\n`);
  const answer = deps.ask(reviewQuestion(items, stale.length - items.length), reviewChoices(items.length), (text) => {
    const label = /^(keep|drop) (all|\d+)$/i.exec(text.trim());
    const parsed = parseReviewAnswer(label ? `${label[1]} ${label[2]}` : text, items.length);
    return parsed ? { value: parsed } : null;
  });
  void answer
    .then(async (decisions) => {
      if (!decisions?.length) return;
      const at = deps.now?.() ?? new Date();
      const applied: string[] = [];
      await deps.write(() => {
        for (const d of decisions) {
          const entry = items[d.index];
          if (entry && applyReviewDecision(deps.home, entry, d.decision, at)) applied.push(`${d.decision} ${entry.title}`);
        }
      }, "chore(tasks): stale review");
      if (!applied.length) deps.warn?.({ decisions }, "stale review answered, but no entry matched any more");
    })
    .catch((err) => deps.warn?.({ err }, "applying the stale review failed"));
  return "sent";
}
