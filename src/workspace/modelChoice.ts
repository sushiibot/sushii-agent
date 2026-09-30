import { DEFAULT_MODELS_SPEC, parseModelList, type ModelEntry, type WorkspaceConfig } from "./config.ts";
import { readJson } from "./files.ts";
import { statePath, writeWorkspaceState } from "./state.ts";

type ModelFields = Pick<WorkspaceConfig, "provider" | "chatgptModel" | "model">;

export type ModelSwitch = { ok: true; entry: ModelEntry; changed: boolean } | { ok: false; error: string };

/**
 * The owner's `!model` choice from the fixed list, persisted in state.json. It rewrites the shared config's
 * provider/chatgptModel/model in place, so main (at its next turn), subagents and jobs (at their next
 * session) follow it. A chatgpt entry still falls back to the configured OpenRouter model; an openrouter
 * entry pins OpenRouter.
 */
export class ModelChoice {
  readonly list: ModelEntry[];
  private readonly base: ModelFields;
  private chosen: ModelEntry | null = null;

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly stateDir: string,
  ) {
    this.list = config.models ?? parseModelList(DEFAULT_MODELS_SPEC);
    this.base = { provider: config.provider, chatgptModel: config.chatgptModel, model: config.model };
    const alias = readJson<{ modelAlias?: unknown }>(statePath(stateDir))?.modelAlias;
    const saved = typeof alias === "string" ? this.find(alias) : undefined;
    if (saved) this.apply(saved);
  }

  /** The chosen entry, else the list entry matching the configured default, else null. */
  current(): ModelEntry | null {
    if (this.chosen) return this.chosen;
    const b = this.base;
    return this.list.find((e) => (b.provider === "chatgpt" ? e.backend === "chatgpt" && e.id === b.chatgptModel : e.backend === "openrouter" && e.id === b.model)) ?? null;
  }

  /** Every OpenRouter model a choice can land on: the configured fallback and the list's pinned entries. */
  openrouterIds(): string[] {
    return [...new Set([this.base.model, ...this.list.filter((e) => e.backend === "openrouter").map((e) => e.id)])];
  }

  select(alias: string): ModelSwitch {
    const entry = this.find(alias);
    if (!entry) return { ok: false, error: `unknown model "${alias}"; choose one of ${this.list.map((e) => e.alias).join(", ")}` };
    const changed = this.current()?.alias !== entry.alias;
    this.apply(entry);
    writeWorkspaceState(this.stateDir, { modelAlias: entry.alias });
    return { ok: true, entry, changed };
  }

  /** `!model`'s reply: the current choice and the list. */
  describe(answering?: string | null): string {
    const cur = this.current();
    const lines = [
      cur ? `Model: **${cur.alias}** (${label(cur)})` : `Model: the configured default (${this.config.provider === "chatgpt" ? `chatgpt:${this.config.chatgptModel}` : `openrouter:${this.config.model}`})`,
      ...(answering ? [`Last answer came from ${answering}.`] : []),
      "",
      ...this.list.map((e) => `${e.alias === cur?.alias ? "▸" : "·"} \`${e.alias}\` — ${label(e)}`),
      "",
      "Switch with `!model <alias>`; it applies from the next turn.",
    ];
    return lines.join("\n");
  }

  private find(alias: string): ModelEntry | undefined {
    const key = alias.trim().toLowerCase();
    return this.list.find((e) => e.alias === key);
  }

  private apply(entry: ModelEntry): void {
    this.chosen = entry;
    const c = this.config;
    if (entry.backend === "chatgpt") {
      c.provider = "chatgpt";
      c.chatgptModel = entry.id;
      c.model = this.base.model;
    } else {
      c.provider = "openrouter";
      c.chatgptModel = this.base.chatgptModel;
      c.model = entry.id;
    }
  }
}

function label(e: ModelEntry): string {
  return e.backend === "chatgpt" ? `ChatGPT ${e.id} (OpenRouter fallback)` : `OpenRouter ${e.id} (pinned)`;
}
