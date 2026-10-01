import { join } from "node:path";
import { readJson, writeFileAtomic } from "./files.ts";

/** The recap a rotation seeded into `sessionFile`, kept until that session is on disk. */
export interface StashedRecap {
  sessionFile: string;
  text: string;
}

/** History markers appended to `sessionFile` while Pi held it only in memory, re-appended if a restart loses them. */
export interface PendingMarkers {
  sessionFile: string;
  entries: Array<{ customType: string; data: unknown }>;
}

export interface WorkspaceState {
  chatSessionFile: string;
  /** The owner's `!model` choice; absent means the configured default. */
  modelAlias?: string;
  /** An OpenRouter model id picked outside the `!model` list; it wins over modelAlias. */
  customModel?: string;
  /** The OpenRouter model a ChatGPT choice falls back to; absent means the configured one. */
  fallbackModel?: string;
  recap?: StashedRecap;
  /** Per surface, whether the bot last said it can upload the files a reply carries. */
  fileSurfaces?: Record<string, boolean>;
  markers?: PendingMarkers;
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

export function readFileSurfaces(stateDir: string): Record<string, boolean> {
  const raw = readJson<{ fileSurfaces?: unknown }>(statePath(stateDir))?.fileSurfaces;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
}

export function readPendingMarkers(stateDir: string): PendingMarkers | null {
  const raw = readJson<{ markers?: { sessionFile?: unknown; entries?: unknown } }>(statePath(stateDir))?.markers;
  if (!raw || typeof raw.sessionFile !== "string" || !Array.isArray(raw.entries)) return null;
  const entries = (raw.entries as Array<{ customType?: unknown; data?: unknown }>)
    .filter((e) => e && typeof e.customType === "string")
    .map((e) => ({ customType: e.customType as string, data: e.data }));
  return { sessionFile: raw.sessionFile, entries };
}

/** Merges `patch` into the stored state; a field set to `undefined` is removed. */
export function writeWorkspaceState(stateDir: string, patch: Partial<WorkspaceState>): void {
  const raw = readJson<Record<string, unknown>>(statePath(stateDir)) ?? {};
  const next: Record<string, unknown> = { ...raw, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  writeFileAtomic(statePath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
}
