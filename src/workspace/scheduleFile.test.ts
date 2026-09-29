import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHomeTemplate } from "./home.ts";
import { ScheduleFile, parseSchedule } from "./scheduleFile.ts";

const VALID = `# Scheduled jobs

Intro text is ignored, even with when: lines.

## morning-brief
when: daily 08:00
active: 07:00-10:00
enabled: true

Brief drk on the day.
Two lines of prompt.

## check-prs
when: every 90 minutes

Look for PRs waiting on drk.

## paused
when: every 2h
enabled: false

Not now.
`;

describe("parseSchedule", () => {
  test("valid entries: fields, prompt body, defaults, disabled", () => {
    const { entries, errors } = parseSchedule(VALID);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      {
        name: "morning-brief",
        schedule: { when: { kind: "daily", at: "08:00" }, active: { start: "07:00", end: "10:00" } },
        prompt: "Brief drk on the day.\nTwo lines of prompt.",
      },
      { name: "check-prs", schedule: { when: { kind: "every", minutes: 90 } }, prompt: "Look for PRs waiting on drk." },
      { name: "paused", schedule: { when: { kind: "every", minutes: 120 }, disabled: true }, prompt: "Not now." },
    ]);
  });

  test("invalid entries are skipped with a reason; the valid ones still load", () => {
    const text = [
      "## Bad Name\nwhen: daily 08:00\n\nx",
      "## no-when\nactive: 08:00-10:00\n\nx",
      "## bad-when\nwhen: hourly\n\nx",
      "## too-often\nwhen: every 1m\n\nx",
      "## bad-active\nwhen: every 60m\nactive: morning\n\nx",
      "## bad-enabled\nwhen: every 60m\nenabled: maybe\n\nx",
      "## unknown-field\nwhen: every 60m\ncolor: blue\n\nx",
      "## no-prompt\nwhen: every 60m\n",
      "## heartbeat\nwhen: every 60m\n\nx",
      "## ok\nwhen: every 60m\n\nfine",
      "## ok\nwhen: every 30m\n\nsecond",
    ].join("\n\n");
    const { entries, errors } = parseSchedule(text, { reserved: ["heartbeat", "consolidation"] });
    expect(entries.map((e) => [e.name, e.prompt])).toEqual([["ok", "fine"]]);
    expect(errors).toHaveLength(10);
    expect(errors[0]).toStartWith("Bad Name:");
    expect(errors.find((e) => e.startsWith("no-when:"))).toContain("missing when");
    expect(errors.find((e) => e.startsWith("heartbeat:"))).toContain("built-in");
    expect(errors.at(-1)).toBe("ok: duplicate job name; only the first is used");
  });

  test("never throws on junk", () => {
    for (const junk of ["", "no headings at all", "##\n", "## \nwhen:", "\r\n## x\r\nwhen: every 10m\r\n\r\nhi\r\n"]) {
      expect(() => parseSchedule(junk)).not.toThrow();
    }
    expect(parseSchedule("## x\r\nwhen: every 10m\r\n\r\nhi\r\n").entries).toEqual([{ name: "x", schedule: { when: { kind: "every", minutes: 10 } }, prompt: "hi" }]);
  });

  test("the scaffolded schedule.md parses to one disabled example", () => {
    const { entries, errors } = parseSchedule(readHomeTemplate("schedule.md"));
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.schedule.disabled).toBe(true);
  });
});

describe("ScheduleFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-schedule-file-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reloads on a change of mtime or size, warns per bad entry, and signals each change", () => {
    const path = join(dir, "schedule.md");
    const warnings: string[] = [];
    let changes = 0;
    const file = new ScheduleFile(path, { warn: (e) => warnings.push(e), onChange: () => changes++ });

    expect(file.entries()).toEqual([]);
    writeFileSync(path, "## a\nwhen: every 10m\n\none\n");
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    const first = file.entries();
    expect(first.map((e) => e.name)).toEqual(["a"]);
    expect(file.entries()).toBe(first);

    // Same size, new mtime.
    writeFileSync(path, "## b\nwhen: every 10m\n\none\n");
    utimesSync(path, new Date(2_000_000), new Date(2_000_000));
    expect(file.entries().map((e) => e.name)).toEqual(["b"]);

    writeFileSync(path, "## b\nwhen: sometimes\n\none\n## c\nwhen: every 10m\n\ntwo\n");
    expect(file.entries().map((e) => e.name)).toEqual(["c"]);
    expect(warnings).toEqual([expect.stringContaining("b: bad when")]);

    unlinkSync(path);
    expect(file.entries()).toEqual([]);
    expect(changes).toBe(5);
  });
});
