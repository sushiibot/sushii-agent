import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Home-relative files and trees a subagent must never change: memory, persona, agent defs/skills, scheduled jobs
 * (they outlive the child), and the home repo's config and hooks (either can run a command during main's next
 * memory commit).
 */
export const PROTECTED_FILES = ["USER.md", "MEMORY.md", "DREAMS.md", "TASKS.md", "SOUL.md", "AGENTS.md", "schedule.md", ".git/config"] as const;
export const PROTECTED_DIRS = ["memory", "tasks", ".agents", ".git/hooks"] as const;
/** Larger files are watched but can't be restored. */
const MAX_RESTORABLE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_ENTRIES = 200_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

type Kind = "file" | "dir" | "symlink" | "other";

interface Entry {
  kind: Kind;
  /** inode, size, mtime, ctime and mode: any write moves at least one of them. */
  key: string;
  mode: number;
  content?: Buffer;
  target?: string;
}

export type Snapshot = Map<string, Entry>;

function kindOf(st: BigIntStats): Kind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function statKey(st: BigIntStats): string {
  return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
}

/** The protected set under `home`; file content is reused from `prev` when the file's stat is unchanged. */
export function snapshotProtected(home: string, prev?: Snapshot | null): Snapshot {
  const snap: Snapshot = new Map();
  const visit = (rel: string) => {
    const path = join(home, rel);
    const st = lstatOrNull(path);
    if (!st) return;
    const kind = kindOf(st);
    const key = statKey(st);
    const mode = Number(st.mode & 0o7777n);
    if (kind === "symlink") {
      let target = "";
      try {
        target = readlinkSync(path);
      } catch {
        // Vanished between lstat and readlink.
      }
      snap.set(rel, { kind, key, mode, target });
    } else if (kind === "dir") {
      snap.set(rel, { kind, key, mode });
      let names: string[] = [];
      try {
        names = readdirSync(path).sort();
      } catch {
        // Unreadable: its entries count as gone.
      }
      for (const name of names) visit(`${rel}/${name}`);
    } else if (kind === "file") {
      const old = prev?.get(rel);
      if (old?.kind === "file" && old.key === key) {
        snap.set(rel, old);
        return;
      }
      let content: Buffer | undefined;
      if (st.size <= BigInt(MAX_RESTORABLE_BYTES)) {
        try {
          content = readFileSync(path);
        } catch {
          // Unreadable: watched by stat only.
        }
      }
      snap.set(rel, { kind, key, mode, ...(content ? { content } : {}) });
    } else {
      snap.set(rel, { kind, key, mode });
    }
  };
  for (const f of PROTECTED_FILES) visit(f);
  for (const d of PROTECTED_DIRS) visit(d);
  return snap;
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  if (a.kind === "dir") return true;
  if (a.kind === "symlink") return a.target === b.target;
  if (a.kind === "file" && a.content && b.content) return a.content.equals(b.content);
  return a.key === b.key;
}

/** Home-relative paths that differ between two snapshots, including ones only one side has. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [rel, a] of before) {
    const b = after.get(rel);
    if (!b || !sameEntry(a, b)) out.push(rel);
  }
  for (const rel of after.keys()) if (!before.has(rel)) out.push(rel);
  return out.sort();
}

function writeReplacing(path: string, content: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  // A fresh temp name opened exclusively, then renamed over: never follows a link planted at either path.
  const tmp = `${path}.restore-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, content, { flag: "wx", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** Puts `paths` back as `baseline` has them; returns the ones that couldn't be restored. */
export function restoreProtected(home: string, baseline: Snapshot, paths: string[]): string[] {
  const failed: string[] = [];
  // Deepest first, so a planted tree goes before its parent.
  for (const rel of paths.filter((p) => !baseline.has(p)).sort((x, y) => y.length - x.length)) {
    try {
      rmSync(join(home, rel), { recursive: true, force: true });
    } catch {
      failed.push(rel);
    }
  }
  // Shallowest first, so a directory exists again before its files.
  for (const rel of paths.filter((p) => baseline.has(p)).sort((x, y) => x.length - y.length)) {
    const e = baseline.get(rel)!;
    const path = join(home, rel);
    try {
      const cur = lstatOrNull(path);
      if (e.kind === "dir") {
        if (cur && !cur.isDirectory()) rmSync(path, { recursive: true, force: true });
        mkdirSync(path, { recursive: true });
        chmodSync(path, e.mode);
      } else if (e.kind === "file" && e.content) {
        if (cur?.isDirectory()) rmSync(path, { recursive: true, force: true });
        writeReplacing(path, e.content, e.mode);
      } else if (e.kind === "symlink" && e.target !== undefined) {
        if (cur) rmSync(path, { recursive: true, force: true });
        symlinkSync(e.target, path);
      } else {
        failed.push(rel);
      }
    } catch {
      failed.push(rel);
    }
  }
  return failed;
}

export type Fingerprint = Map<string, string>;

/**
 * A stat fingerprint of every entry under `root` except the skipped subtrees and node_modules. Stat only:
 * enough to see that something changed, not to undo it.
 */
export function fingerprintTree(root: string, skip: (rel: string) => boolean, maxEntries = MAX_PROJECT_ENTRIES): { entries: Fingerprint; truncated: boolean } {
  const entries: Fingerprint = new Map();
  let truncated = false;
  const walk = (rel: string) => {
    if (truncated) return;
    let names: string[];
    try {
      names = readdirSync(rel ? join(root, rel) : root).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules") continue;
      const child = rel ? `${rel}/${name}` : name;
      if (skip(child)) continue;
      if (entries.size >= maxEntries) {
        truncated = true;
        return;
      }
      const st = lstatOrNull(join(root, child));
      if (!st) continue;
      const kind = kindOf(st);
      // A directory's times move whenever an entry is added below it, including in skipped subtrees.
      entries.set(child, kind === "dir" ? `dir:${st.ino}:${st.mode}` : `${kind}:${statKey(st)}`);
      if (kind === "dir") walk(child);
    }
  };
  walk("");
  return { entries, truncated };
}

export function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const out: string[] = [];
  for (const [rel, v] of before) if (after.get(rel) !== v) out.push(rel);
  for (const rel of after.keys()) if (!before.has(rel)) out.push(rel);
  return out.sort();
}

type Log = { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

interface Lease {
  /** Home-relative paths the write may touch; null: anything. */
  paths: string[] | null;
  end: number | null;
}

/** A child the watch checks for; a writer may change the given project subtrees. */
export interface WatchedChild {
  runId: string;
  writer: boolean;
  /** Home-relative paths under projects/ this child may write (its worktree, its repo's git internals). */
  allowedProjectPaths: string[];
  onTamper: (tamper: TamperReport) => void;
}

export interface TamperReport {
  /** Home-relative paths a subagent changed. */
  paths: string[];
  /** Protected paths that couldn't be put back. */
  unrestored: string[];
}

export interface CheckResult {
  tamper: TamperReport | null;
  /** Changes left in place because a main-side write overlapped the window. */
  conflicts: string[];
}

function covers(leasePath: string, rel: string): boolean {
  return rel === leasePath || rel.startsWith(`${leasePath}/`) || leasePath.startsWith(`${rel}/`);
}

/**
 * Detect-and-revert for subagents. Between two checks (each child tool call's start and end), any change to
 * the protected set is put back from the last snapshot, and any change under projects/ outside a live
 * writer's own paths is reported; both fail the writer children. A change a main-side write could explain
 * (a main tool call, compaction handoff, consolidation) is left alone and logged as a conflict.
 */
export class ProtectedWatch {
  private readonly children = new Map<string, WatchedChild>();
  private readonly leases = new Set<Lease>();
  private memory: Snapshot | null = null;
  private projects: Fingerprint | null = null;
  // A logical clock, not wall time: a lease that ended in the same millisecond as a check must still order before it.
  private seq = 0;
  private checkedAt = 0;

  constructor(private readonly opts: { home: string; log: Log }) {}

  private now(): number {
    return ++this.seq;
  }

  /** Marks a main-side write in progress; call the result when it ends. Expires after `maxMs` if never ended. */
  mainWrite(paths: string[] | null = null, maxMs = DEFAULT_LEASE_MS): () => void {
    const lease: Lease = { paths, end: null };
    this.leases.add(lease);
    const timer = setTimeout(() => end(), maxMs);
    timer.unref?.();
    const end = () => {
      clearTimeout(timer);
      if (lease.end === null) lease.end = this.now();
    };
    return end;
  }

  /** Runs `fn` under a main-side write lease. */
  async whileMainWrites<T>(fn: () => Promise<T>, paths: string[] | null = null): Promise<T> {
    const end = this.mainWrite(paths, 24 * 60 * 60_000);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  get watching(): number {
    return this.children.size;
  }

  attach(child: WatchedChild): void {
    if (this.children.size) this.check(child.runId);
    this.children.set(child.runId, child);
    if (!this.memory) {
      this.memory = snapshotProtected(this.opts.home);
      this.checkedAt = this.now();
    }
    if (child.writer) this.projects = this.fingerprintProjects();
  }

  detach(runId: string): void {
    const child = this.children.get(runId);
    if (!child) return;
    this.children.delete(runId);
    if (!this.children.size) {
      this.memory = null;
      this.projects = null;
      // A lease still open (consolidation, a long main bash call) must cover the next child's windows too.
      for (const l of this.leases) if (l.end !== null) this.leases.delete(l);
      return;
    }
    if (child.writer) this.projects = this.hasWriter() ? this.fingerprintProjects() : null;
  }

  /** Compares against the last check, restores and reports; `runId` is the child whose tool call triggered it. */
  check(runId: string): CheckResult {
    if (!this.memory) return { tamper: null, conflicts: [] };
    const since = this.checkedAt;
    const at = this.now();
    const conflicts: string[] = [];
    const tampered: string[] = [];
    const current = snapshotProtected(this.opts.home, this.memory);
    const memChanged = diffSnapshots(this.memory, current);
    for (const rel of memChanged) (this.mainTouched(rel, since) ? conflicts : tampered).push(rel);
    const unrestored = tampered.length ? restoreProtected(this.opts.home, this.memory, tampered) : [];
    this.memory = tampered.length ? snapshotProtected(this.opts.home, current) : current;

    if (this.projects) {
      const next = this.fingerprintProjects();
      for (const rel of diffFingerprints(this.projects, next)) {
        const homeRel = `projects/${rel}`;
        (this.mainTouched(homeRel, since) ? conflicts : tampered).push(homeRel);
      }
      this.projects = next;
    }
    this.checkedAt = at;
    this.pruneLeases();

    if (conflicts.length) this.opts.log.warn({ runId, paths: conflicts.slice(0, 20) }, "protected paths changed while a main-side write was in progress; left as they are");
    if (!tampered.length) return { tamper: null, conflicts };
    const tamper: TamperReport = { paths: tampered, unrestored };
    this.opts.log.error({ runId, paths: tampered.slice(0, 20), unrestored }, "a subagent changed protected paths; restored what could be and failing it");
    // Read-only children have no tool that writes, so a change is laid on the writers when any are live.
    const writers = [...this.children.values()].filter((c) => c.writer);
    const blamed = writers.length ? writers : [this.children.get(runId)].filter((c): c is WatchedChild => !!c);
    for (const c of blamed) c.onTamper(tamper);
    return { tamper, conflicts };
  }

  private hasWriter(): boolean {
    return [...this.children.values()].some((c) => c.writer);
  }

  private fingerprintProjects(): Fingerprint {
    const allowed = [...this.children.values()].flatMap((c) => c.allowedProjectPaths);
    const { entries, truncated } = fingerprintTree(join(this.opts.home, "projects"), (rel) => allowed.some((a) => rel === a || rel.startsWith(`${a}/`)));
    if (truncated) this.opts.log.warn({ max: MAX_PROJECT_ENTRIES }, "projects/ has too many entries to watch in full; the rest is unwatched");
    return entries;
  }

  private mainTouched(rel: string, since: number): boolean {
    for (const l of this.leases) {
      if (l.end !== null && l.end < since) continue;
      if (l.paths === null || l.paths.some((p) => covers(p, rel))) return true;
    }
    return false;
  }

  private pruneLeases(): void {
    for (const l of this.leases) if (l.end !== null && l.end < this.checkedAt) this.leases.delete(l);
  }
}
