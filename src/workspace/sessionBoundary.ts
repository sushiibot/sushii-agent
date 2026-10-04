import { join } from "node:path";
import { SESSION_FILES_MAX, SESSION_TEXT_MAX, type SessionBoundary } from "../orchestration/sessionContracts.ts";
import { memoryDetail, memoryOverview } from "../orchestration/memoryContracts.ts";
import { memoryHandlers } from "./memoryFiles.ts";
import { readJson, writeFileAtomic } from "./files.ts";

/** Records shared-memory changes since this conversation's last boundary. Not edit attribution. */
export class SessionBoundaryRecorder {
  private baseline: Record<string, string> | null;
  private readonly path: string;
  private readonly read: (raw: unknown) => Promise<unknown>;
  constructor(home: string, stateDir: string) {
    this.path = join(stateDir, "session-memory-baseline.json");
    this.baseline = readJson<Record<string, string>>(this.path);
    this.read = memoryHandlers({ home, principalId: "boundary" })["memory/read"]!;
  }
  private async overview() {
    return memoryOverview.parse(await this.read({ principalId: "boundary" }));
  }
  private save(files: Awaited<ReturnType<SessionBoundaryRecorder["overview"]>>["files"]) {
    this.baseline = Object.fromEntries(files.map(f => [f.path, `${f.updatedAt}:${f.lines}`]));
    writeFileAtomic(this.path, JSON.stringify(this.baseline));
  }
  async initialize() {
    if (this.baseline === null) this.save((await this.overview()).files);
  }
  async capture(context: readonly { path: string; content: string }[]): Promise<Pick<SessionBoundary, "memory" | "context">> {
    const overview = await this.overview();
    const files: NonNullable<SessionBoundary["memory"]>["files"] = [];
    let truncated = overview.truncated;
    const current = new Set(overview.files.map(f => f.path));
    for (const file of overview.files) {
      if (this.baseline?.[file.path] === `${file.updatedAt}:${file.lines}`) continue;
      if (files.length >= SESSION_FILES_MAX) { truncated = true; continue; }
      const detail = memoryDetail.parse(await this.read({ principalId: "boundary", id: file.id }));
      if (!detail) { truncated = true; continue; }
      files.push({ path: file.path, content: detail.file.content.slice(0, SESSION_TEXT_MAX), truncated: detail.file.truncated || detail.file.content.length > SESSION_TEXT_MAX, change: this.baseline?.[file.path] === undefined ? "added" : "changed" });
    }
    // A bounded overview cannot establish that omitted files were removed.
    if (!overview.truncated) for (const path of Object.keys(this.baseline ?? {})) {
      if (current.has(path)) continue;
      if (files.length >= SESSION_FILES_MAX) { truncated = true; break; }
      files.push({ path, content: "", truncated: false, change: "removed" });
    }
    this.save(overview.files);
    return {
      memory: { files, truncated },
      context: {
        files: context.slice(0, SESSION_FILES_MAX).map(f => ({ path: f.path, content: f.content.slice(0, SESSION_TEXT_MAX), truncated: f.content.length > SESSION_TEXT_MAX })),
        truncated: context.length > SESSION_FILES_MAX,
      },
    };
  }
}
