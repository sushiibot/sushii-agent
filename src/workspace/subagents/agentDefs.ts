import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Home-relative dir of the agent defs; under `.agents/`, so the home repo versions them. */
export const AGENT_DEFS_DIR = ".agents/agents";

export const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

const READ_ONLY_DEFAULT: BuiltinTool[] = ["read", "grep", "find", "ls"];

// Claude Code tool names map onto Pi's; names outside both (WebSearch, the bot tools, MCP) are ignored,
// since every child gets the bot-proxied tools anyway.
const CLAUDE_CODE_TOOLS: Record<string, BuiltinTool> = {
  Read: "read",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
  Bash: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
};

export interface AgentDef {
  name: string;
  description: string;
  /** Pi built-in tools, in canonical order. */
  tools: BuiltinTool[];
  /** A pinned OpenRouter model id; undefined follows the shared backend (ChatGPT, or OpenRouter during a cool-down). */
  model?: string;
  maxTurns?: number;
  /** Default mode when the caller doesn't say. */
  background: boolean;
  /** Can edit files: counts against the single writer slot and runs in its own git worktree. Only writers get bash. */
  writer: boolean;
  /** The system prompt: the file body. */
  prompt: string;
  path: string;
}

function list(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const items = Array.isArray(val) ? val.map((v) => String(v).trim()) : String(val).split(",").map((v) => v.trim());
  return items.filter(Boolean);
}

export function mapTools(names: string[] | undefined): BuiltinTool[] {
  if (names === undefined) return [...READ_ONLY_DEFAULT];
  const out = new Set<BuiltinTool>();
  for (const n of names) {
    const tool = CLAUDE_CODE_TOOLS[n] ?? (BUILTIN_TOOLS as readonly string[]).find((t) => t === n);
    if (tool) out.add(tool as BuiltinTool);
  }
  return BUILTIN_TOOLS.filter((t) => out.has(t));
}

/**
 * `provider/model` pins an OpenRouter model (`openai/gpt-…` is OpenRouter's id, not ChatGPT); an explicit
 * `openrouter/` prefix is dropped when a `provider/model` id remains, so `openrouter/auto` stays itself.
 * Claude Code aliases and "inherit" follow the shared backend.
 */
function modelId(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const v = val.trim();
  if (!v || v === "inherit" || !v.includes("/")) return undefined;
  const rest = v.startsWith("openrouter/") ? v.slice("openrouter/".length) : null;
  return rest?.includes("/") ? rest : v;
}

function positiveInt(val: unknown): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val > 0 ? val : undefined;
}

export function parseAgentDef(path: string, content: string): AgentDef {
  const { frontmatter: fm, body } = parseFrontmatter(content);
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : basename(path, ".md");
  const disallowed = new Set(mapTools(list(fm.disallowedTools) ?? []));
  const listed = mapTools(list(fm.tools)).filter((t) => !disallowed.has(t));
  const writer = listed.includes("edit") || listed.includes("write");
  // Bash can write anywhere the process can, so a read-only def never gets it, whatever its file says.
  const tools = writer ? listed : listed.filter((t) => t !== "bash");
  return {
    name,
    description: typeof fm.description === "string" ? fm.description.trim() : name,
    tools,
    model: modelId(fm.model),
    maxTurns: positiveInt(fm.maxTurns ?? fm.max_turns),
    background: fm.background === true,
    writer,
    prompt: body.trim(),
    path,
  };
}

/** The defs in `<home>/.agents/agents/*.md`, keyed by name; unreadable files are skipped. Read fresh on each call. */
export function loadAgentDefs(home: string, onError?: (path: string, err: unknown) => void): Map<string, AgentDef> {
  const dir = join(home, AGENT_DEFS_DIR);
  const defs = new Map<string, AgentDef>();
  if (!existsSync(dir)) return defs;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const path = join(dir, file);
    try {
      const def = parseAgentDef(path, readFileSync(path, "utf8"));
      defs.set(def.name, def);
    } catch (err) {
      onError?.(path, err);
    }
  }
  return defs;
}
