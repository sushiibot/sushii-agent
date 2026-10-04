import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_TEMPLATE_HASHES } from "./homeTemplateHashes.ts";

/**
 * Home path → template file, for the files a template upgrade may replace. Memory (USER.md, MEMORY.md,
 * DREAMS.md, memory/) and tasks (TASKS.md, tasks/) are never upgraded.
 */
export const UPGRADABLE_TEMPLATES: Record<string, string> = {
  "AGENTS.md": "AGENTS.md",
  "SOUL.md": "SOUL.md",
  "schedule.md": "schedule.md",
  ".gitignore": "gitignore",
  ".agents/skills/README.md": "agents-skills-README.md",
  ".agents/skills/session-history/SKILL.md": "agents-skills-session-history-SKILL.md",
  ".agents/skills/documents/SKILL.md": "agents-skills-documents-SKILL.md",
  ".agents/agents/explore.md": "agents-agents-explore.md",
  ".agents/agents/researcher.md": "agents-agents-researcher.md",
  ".agents/agents/reviewer.md": "agents-agents-reviewer.md",
  ".agents/agents/coder.md": "agents-agents-coder.md",
};

const TEMPLATE_DIR = join(import.meta.dir, "home-template");
// Lines the scaffold appends to an existing .gitignore for files added to the template later.
const APPENDED_ALLOW = /^!\/(?:schedule\.md|TASKS\.md|tasks\/|memory\/topics\/|memory\/topics\/\*\.md)$/;

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The content, plus for .gitignore the content without the allow lines the scaffold appended. */
function candidates(homePath: string, text: string): string[] {
  if (homePath !== ".gitignore") return [text];
  const lines = text.replace(/\n$/, "").split("\n");
  while (lines.length && APPENDED_ALLOW.test(lines.at(-1)!)) lines.pop();
  return [text, `${lines.join("\n")}\n`];
}

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/**
 * Replaces each upgradable home file that is byte-identical to an earlier shipped template with the current
 * template, committing each one; a file drk edited (no hash match) is left alone. Returns the upgraded paths.
 */
export async function upgradeHomeTemplates(
  home: string,
  opts: { commit: (path: string, message: string) => Promise<unknown>; log: Log; hashes?: Record<string, readonly string[]> },
): Promise<string[]> {
  const hashes = opts.hashes ?? SHIPPED_TEMPLATE_HASHES;
  const upgraded: string[] = [];
  for (const [homePath, file] of Object.entries(UPGRADABLE_TEMPLATES)) {
    let current: string;
    let template: string;
    try {
      current = readFileSync(join(home, homePath), "utf8");
      template = readFileSync(join(TEMPLATE_DIR, file), "utf8");
    } catch {
      continue;
    }
    if (current === template) continue;
    const shipped = new Set(hashes[file] ?? []);
    if (!candidates(homePath, current).some((c) => shipped.has(sha256(c)))) {
      opts.log.info({ file: homePath }, `${homePath} differs from the shipped template; not upgraded`);
      continue;
    }
    writeFileSync(join(home, homePath), template);
    try {
      await opts.commit(homePath, `home: upgrade ${homePath} template`);
    } catch (err) {
      opts.log.warn({ err, file: homePath }, "committing a template upgrade failed");
    }
    upgraded.push(homePath);
  }
  if (upgraded.length) opts.log.info({ files: upgraded }, "upgraded home files to the current templates");
  return upgraded;
}
