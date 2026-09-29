import { join } from "node:path";
import { readJson, writeFileAtomic } from "./files.ts";

export interface WorkspaceState {
  chatSessionFile: string;
}

export function statePath(stateDir: string): string {
  return join(stateDir, "state.json");
}

export function readWorkspaceState(stateDir: string): WorkspaceState | null {
  const state = readJson<Partial<WorkspaceState>>(statePath(stateDir));
  return typeof state?.chatSessionFile === "string" && state.chatSessionFile ? { chatSessionFile: state.chatSessionFile } : null;
}

export function writeWorkspaceState(stateDir: string, state: WorkspaceState): void {
  writeFileAtomic(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}
