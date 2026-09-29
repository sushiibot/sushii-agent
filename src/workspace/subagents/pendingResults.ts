import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatOrigin } from "../../orchestration/contracts.ts";
import { writeFileAtomic } from "../files.ts";

/** A background child's result that the main session hasn't received yet. */
export interface PendingResult {
  runId: string;
  agent: string;
  status: string;
  /** The wake message's full text. */
  text: string;
  /** Where the delegating turn came from; the reply goes back there. */
  origin?: ChatOrigin;
  createdAt: string;
}

type Line = { type: "result"; result: PendingResult } | { type: "consumed"; runId: string };

/**
 * Append-only JSONL of background results (result on completion, consumed once main's session has the
 * message), compacted on load. Survives a restart, so delivery is at-least-once.
 */
export class PendingResults {
  readonly path: string;
  private readonly pending = new Map<string, PendingResult>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "subagent-results.jsonl");
    this.load();
  }

  add(result: PendingResult): void {
    this.write({ type: "result", result });
    this.pending.set(result.runId, result);
  }

  /** False when the runId was unknown or already consumed. */
  consume(runId: string): boolean {
    if (!this.pending.has(runId)) return false;
    this.write({ type: "consumed", runId });
    this.pending.delete(runId);
    return true;
  }

  list(): PendingResult[] {
    return [...this.pending.values()];
  }

  private write(line: Line): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    for (const raw of readFileSync(this.path, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // a torn last line from a crash mid-append
      }
      if (line.type === "result") this.pending.set(line.result.runId, line.result);
      else if (line.type === "consumed") this.pending.delete(line.runId);
    }
    writeFileAtomic(this.path, this.list().map((result) => `${JSON.stringify({ type: "result", result } satisfies Line)}\n`).join(""));
  }
}
