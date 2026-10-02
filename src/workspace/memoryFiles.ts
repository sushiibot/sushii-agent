import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MEMORY_FILE_MAX, memoryParams } from "../orchestration/memoryContracts.ts";
import { SAFE_OPEN, fdPath } from "./runReader.ts";

const TOP = ["MEMORY.md", "USER.md", "DREAMS.md"];
function isMemoryPath(path: string): boolean {
  if (TOP.includes(path)) return true;
  if (!/^memory\/(?:[^/.][^/]*\/)*[^/.][^/]*\.md$/.test(path)) return false;
  return !path.split("/").some((part) => part === ".." || part.includes("\\") || part.includes("\0"));
}

const idFor = (path: string) => Buffer.from(path).toString("base64url");

function describeMemory(path: string): string {
  switch (path) {
    case "USER.md":
      return "Your profile and preferences";
    case "MEMORY.md":
      return "Saved facts, decisions and projects";
    case "DREAMS.md":
      return "Memory review and consolidation log";
    default:
      return /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path) ? "Daily memory notes" : "Saved memory notes";
  }
}

/** Only regular, singly linked markdown files under the real home. Parent symlinks are refused too. */
async function read(home: string, path: string) {
  if (!isMemoryPath(path)) return null;
  const root = await realpath(home);
  const full = join(root, path);
  let parent = dirname(full);
  while (parent !== root) {
    const st = await lstat(parent).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) return null;
    parent = dirname(parent);
  }
  const fh = await open(full, SAFE_OPEN).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1 || (fdPath(fh.fd) ?? (await realpath(full))) !== full) return null;
    const buf = Buffer.alloc(Math.min(st.size, MEMORY_FILE_MAX));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const content = buf.subarray(0, bytesRead).toString("utf8");
    return {
      id: idFor(path),
      path,
      about: describeMemory(path),
      updatedAt: st.mtime.toISOString(),
      lines: content ? content.split("\n").length : 0,
      content,
      truncated: st.size > MEMORY_FILE_MAX,
    };
  } finally {
    await fh.close();
  }
}

export function memoryHandlers(opts: { home: string; principalId: string }) {
  return {
    "memory/read": async (raw: unknown) => {
      const p = memoryParams.parse(raw);
      if (p.principalId !== opts.principalId) throw new Error("wrong principal");
      if (p.id !== undefined) {
        const path = Buffer.from(p.id, "base64url").toString("utf8");
        if (idFor(path) !== p.id) return null;
        const file = await read(opts.home, path);
        return file ? { file, writes: [] } : null;
      }
      const paths = [...TOP];
      let entries = 0;
      let truncated = false;
      async function walk(rel: string, depth: number) {
        const full = join(opts.home, rel);
        const st = await lstat(full).catch(() => null);
        if (!st?.isDirectory() || st.isSymbolicLink()) return;
        const dir = await opendir(full);
        for await (const entry of dir) {
          if (++entries > 10000 || paths.length >= 500) {
            truncated = true;
            break;
          }
          const path = `${rel}/${entry.name}`;
          if (entry.isDirectory() && depth < 8) await walk(path, depth + 1);
          else if (entry.isFile() && isMemoryPath(path)) paths.push(path);
          else if (entry.isDirectory() && depth >= 8) truncated = true;
        }
      }
      await walk("memory", 0);
      const files = [];
      for (const path of paths.sort()) {
        const file = await read(opts.home, path);
        if (file) {
          const { content: _, truncated: cut, ...summary } = file;
          files.push(summary);
          truncated ||= cut;
        }
      }
      return { files, writes: [], truncated };
    },
  };
}
