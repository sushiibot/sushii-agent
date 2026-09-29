import { readFileSync, statSync } from "node:fs";
import { isValidJobName, parseActiveHours, parseWhen, type JobSchedule } from "./scheduler.ts";

// No logger import, so CLIs can use this module without pino writing onto their stdout.

/** One job from ~/schedule.md. */
export interface ScheduleEntry {
  name: string;
  schedule: JobSchedule;
  prompt: string;
}

export interface ParsedSchedule {
  entries: ScheduleEntry[];
  /** One line per skipped entry. */
  errors: string[];
}

const HEADING = /^##\s+(.*?)\s*$/;
const FIELD = /^([a-z]+):\s*(.*?)\s*$/i;
const KNOWN_FIELDS = new Set(["when", "active", "enabled"]);

/**
 * Parses schedule.md: each `## <name>` heading starts a job, followed by `key: value` lines (`when`, `active`,
 * `enabled`), a blank line, then the prompt. Text before the first heading is ignored. An invalid entry is
 * skipped and reported in `errors`; this never throws.
 */
export function parseSchedule(text: string, opts: { reserved?: readonly string[] } = {}): ParsedSchedule {
  const entries: ScheduleEntry[] = [];
  const errors: string[] = [];
  const sections: { name: string; lines: string[] }[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) sections.push({ name: heading[1]!, lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  const seen = new Set<string>();
  for (const { name, lines } of sections) {
    const fail = (why: string) => errors.push(`${name || "(unnamed)"}: ${why}`);
    if (!isValidJobName(name)) {
      fail("job names are lowercase letters, digits and hyphens");
      continue;
    }
    if (opts.reserved?.includes(name)) {
      fail("that name belongs to a built-in job");
      continue;
    }
    if (seen.has(name)) {
      fail("duplicate job name; only the first is used");
      continue;
    }
    seen.add(name);

    let i = 0;
    while (i < lines.length && !lines[i]!.trim()) i++;
    const fields = new Map<string, string>();
    let bad: string | null = null;
    for (; i < lines.length && lines[i]!.trim(); i++) {
      const field = FIELD.exec(lines[i]!.trim());
      const key = field?.[1]!.toLowerCase();
      if (!field || !key || !KNOWN_FIELDS.has(key)) {
        bad = `expected when/active/enabled lines before a blank line, got "${lines[i]!.trim().slice(0, 60)}"`;
        break;
      }
      fields.set(key, field[2]!);
    }
    if (bad) {
      fail(bad);
      continue;
    }
    const prompt = lines.slice(i).join("\n").trim();

    const whenRaw = fields.get("when");
    const when = whenRaw === undefined ? null : parseWhen(whenRaw);
    if (!when) {
      fail(whenRaw === undefined ? "missing when:" : `bad when: "${whenRaw}" (use "daily HH:MM" or "every N minutes", 5 to 1440)`);
      continue;
    }
    const schedule: JobSchedule = { when };
    const activeRaw = fields.get("active");
    if (activeRaw !== undefined) {
      const active = parseActiveHours(activeRaw);
      if (!active) {
        fail(`bad active: "${activeRaw}" (use HH:MM-HH:MM)`);
        continue;
      }
      schedule.active = active;
    }
    const enabledRaw = fields.get("enabled")?.toLowerCase();
    if (enabledRaw !== undefined && !["true", "false", "yes", "no"].includes(enabledRaw)) {
      fail(`bad enabled: "${enabledRaw}" (use true or false)`);
      continue;
    }
    if (enabledRaw === "false" || enabledRaw === "no") schedule.disabled = true;
    if (!prompt) {
      fail("no prompt after the when/active/enabled lines");
      continue;
    }
    entries.push({ name, schedule, prompt });
  }
  return { entries, errors };
}

export interface ScheduleFileOptions {
  reserved?: readonly string[];
  /** Once per skipped entry, each time the file is (re)loaded. */
  warn?: (error: string) => void;
  /** After each (re)load that found the file changed, the first load included. */
  onChange?: () => void;
}

/** ~/schedule.md, re-parsed only when its mtime or size changes. A missing or unreadable file has no jobs. */
export class ScheduleFile {
  private signature: string | null = null;
  private cached: ScheduleEntry[] = [];

  constructor(
    readonly path: string,
    private readonly opts: ScheduleFileOptions = {},
  ) {}

  /** The current entries; the same array until the file changes. */
  entries(): ScheduleEntry[] {
    let signature: string;
    try {
      const st = statSync(this.path);
      signature = `${st.mtimeMs}:${st.size}`;
    } catch {
      signature = "missing";
    }
    if (signature === this.signature) return this.cached;
    this.signature = signature;
    let text = "";
    if (signature !== "missing") {
      try {
        text = readFileSync(this.path, "utf8");
      } catch (err) {
        this.opts.warn?.(`unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const { entries, errors } = parseSchedule(text, { reserved: this.opts.reserved });
    for (const e of errors) this.opts.warn?.(e);
    this.cached = entries;
    this.opts.onChange?.();
    return entries;
  }
}
