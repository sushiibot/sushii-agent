// Generic read-only filesystem tools, host-gated on `fs` (a root-scoped filesystem the surface
// provides per space — currently the wiki-sync knowledge base). The model browses/searches/reads
// like a small filesystem; results name the source via the host label + carry citation links.
import type { ToolEntry } from "../../contracts.ts";
import "../hosts.ts";

export const listFilesEntry: ToolEntry<"fs"> = {
  name: "list_files",
  definition: {
    name: "list_files",
    description:
      "List the reference files and folders available to you for this space (its knowledge base). Call with no argument for the top level, or a folder path to browse into it.",
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "Folder path to list (optional; omit for the top level)." } },
      required: [],
    },
  },
  requiresHosts: ["fs"],
  async execute(input, ctx) {
    const dir = input.dir as string | undefined;
    const entries = await ctx.fs.list(dir);
    if (entries === null) return { content: `No such folder: ${dir ?? "(root)"}` };
    if (entries.length === 0) return { content: `Empty: ${dir ?? "(root)"}` };
    const header = `${ctx.fs.label} — ${dir ? `contents of ${dir}` : "top level"}:`;
    return { content: `${header}\n${entries.map((e) => e.path).join("\n")}` };
  },
};

export const searchFilesEntry: ToolEntry<"fs"> = {
  name: "search_files",
  definition: {
    name: "search_files",
    description:
      "Search (grep) the reference files available to you for this space. Returns matching lines with their file, line number, and a citation link. Prefer this for documented background before live lookups; read_file the promising matches, and cite the link when you use one.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms or a pattern." },
        limit: { type: "number", description: "Max matching lines to return (default 25)." },
      },
      required: ["query"],
    },
  },
  requiresHosts: ["fs"],
  async execute(input, ctx) {
    const query = input.query as string;
    const matches = await ctx.fs.grep(query, input.limit as number | undefined);
    if (matches.length === 0) return { content: `No matches for "${query}" in ${ctx.fs.label}.` };
    const lines = matches.map((m) => `${m.path}:${m.line}${m.url ? ` (${m.url})` : ""}\n  ${m.text.trim()}`);
    return { content: `${ctx.fs.label} — matches for "${query}":\n${lines.join("\n")}` };
  },
};

export const readFileEntry: ToolEntry<"fs"> = {
  name: "read_file",
  definition: {
    name: "read_file",
    description: "Read the full content of a reference file by its path (from list_files or search_files).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path within this space's files." } },
      required: ["path"],
    },
  },
  requiresHosts: ["fs"],
  async execute(input, ctx) {
    const path = input.path as string;
    const file = await ctx.fs.read(path);
    if (!file) return { content: `File not found: ${path}` };
    return { content: file.url ? `${file.url}\n\n${file.content}` : file.content };
  },
};

export const FS_TOOL_ENTRIES: ToolEntry<"fs">[] = [listFilesEntry, searchFilesEntry, readFileEntry];
