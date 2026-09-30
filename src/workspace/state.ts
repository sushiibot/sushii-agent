import { join } from "node:path";
import { readJson, writeFileAtomic } from "./files.ts";

/** The recap a rotation seeded into `sessionFile`, kept until that session is on disk. */
export interface StashedRecap {
  sessionFile: string;
  text: string;
}

export interface WorkspaceState {
  chatSessionFile: string;
  /** The owner's `!model` choice; absent means the configured default. */
  modelAlias?: string;
  recap?: StashedRecap;
}

export function statePath(stateDir: string): string {
  return join(stateDir, "state.json");
}

export function readWorkspaceState(stateDir: string): WorkspaceState | null {
  const state = readJson<Partial<WorkspaceState>>(statePath(stateDir));
  if (typeof state?.chatSessionFile !== "string" || !state.chatSessionFile) return null;
  const recap = state.recap;
  return {
    chatSessionFile: state.chatSessionFile,
    ...(typeof state.modelAlias === "string" && state.modelAlias ? { modelAlias: state.modelAlias } : {}),
    ...(recap && typeof recap.sessionFile === "string" && typeof recap.text === "string" ? { recap: { sessionFile: recap.sessionFile, text: recap.text } } : {}),
  };
}

/** Merges `patch` into the stored state; a field set to `undefined` is removed. */
export function writeWorkspaceState(stateDir: string, patch: Partial<WorkspaceState>): void {
  const raw = readJson<Record<string, unknown>>(statePath(stateDir)) ?? {};
  const next: Record<string, unknown> = { ...raw, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  writeFileAtomic(statePath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
}
