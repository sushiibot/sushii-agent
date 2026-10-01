import { DEFAULT_MODELS_SPEC, parseModelList, type ModelEntry, type WorkspaceConfig } from "./config.ts";
import { readJson } from "./files.ts";
import { statePath, writeWorkspaceState } from "./state.ts";

type ModelFields = Pick<WorkspaceConfig, "provider" | "chatgptModel" | "model">;

export type ModelSwitch = { ok: true; entry: ModelEntry; changed: boolean } | { ok: false; error: string };

/**
 * The owner's model choice, persisted in state.json: an entry of the fixed list, or any OpenRouter model
 * id, plus the OpenRouter model a ChatGPT choice falls back to. It rewrites the shared config's
 * provider/chatgptModel/model in place, so main (at its next turn), subagents and jobs (at their next
 * session) follow it. Listeners run on every change, so a live session can register a new model first.
 */
export class ModelChoice {
  readonly list: ModelEntry[];
  private readonly base: ModelFields;
  private chosen: ModelEntry | null = null;
  private fallback: string | null = null;
  private readonly preparers = new Set<(ids: string[]) => Promise<void>>();

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly stateDir: string,
  ) {
    this.list = config.models ?? parseModelList(DEFAULT_MODELS_SPEC);
    this.base = { provider: config.provider, chatgptModel: config.chatgptModel, model: config.model };
    const saved = readJson<{ modelAlias?: unknown; customModel?: unknown; fallbackModel?: unknown }>(statePath(stateDir));
    if (typeof saved?.fallbackModel === "string" && isChatModelId(saved.fallbackModel)) this.fallback = saved.fallbackModel;
    const entry =
      typeof saved?.customModel === "string" && isChatModelId(saved.customModel)
        ? this.entryFor(saved.customModel)
        : typeof saved?.modelAlias === "string"
          ? this.find(saved.modelAlias)
          : undefined;
    if (entry) this.apply(entry);
    else if (this.fallback && this.config.provider === "chatgpt") this.config.model = this.currentFallback();
  }

  /** The chosen entry, else the list entry matching the configured default, else null. */
  current(): ModelEntry | null {
    if (this.chosen) return this.chosen;
    const b = this.base;
    return this.list.find((e) => (b.provider === "chatgpt" ? e.backend === "chatgpt" && e.id === b.chatgptModel : e.backend === "openrouter" && e.id === b.model)) ?? null;
  }

  /** The OpenRouter model a ChatGPT choice falls back to. */
  currentFallback(): string {
    return this.fallback ?? this.base.model;
  }

  /** Every OpenRouter model a choice can land on: the fallbacks, the list's pinned entries and a custom pick. */
  openrouterIds(): string[] {
    const cur = this.current();
    return [
      ...new Set([
        this.base.model,
        this.currentFallback(),
        ...this.list.filter((e) => e.backend === "openrouter").map((e) => e.id),
        ...(cur?.backend === "openrouter" ? [cur.id] : []),
      ]),
    ];
  }

  /** The list entry for `target` (an alias, or a listed OpenRouter id), else a custom OpenRouter entry. */
  resolve(target: string): ModelEntry | undefined {
    const t = target.trim();
    return this.find(t) ?? (isChatModelId(t) ? this.entryFor(t) : undefined);
  }

  /** `target` is a list alias, or any OpenRouter model id ("vendor/model"). The live sessions register the
   *  model before the config changes, so the next turn can never land on a model that isn't there. */
  async select(target: string): Promise<ModelSwitch> {
    const entry = this.resolve(target);
    if (!entry) return { ok: false, error: `unknown model "${target}"; choose one of ${this.list.map((e) => e.alias).join(", ")}, or an OpenRouter id like deepseek/deepseek-v4-pro` };
    const prepared = await this.prepare(entry.backend === "openrouter" ? [entry.id] : []);
    if (prepared) return { ok: false, error: prepared };
    const changed = this.current()?.alias !== entry.alias;
    this.apply(entry);
    const listed = this.list.includes(entry);
    writeWorkspaceState(this.stateDir, { modelAlias: listed ? entry.alias : undefined, customModel: listed ? undefined : entry.id });
    return { ok: true, entry, changed };
  }

  /** Sets the OpenRouter model a ChatGPT choice falls back to; null goes back to the configured one. */
  async selectFallback(id: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
    if (id !== null && !isChatModelId(id)) return { ok: false, error: `"${id}" isn't an OpenRouter model a chat can use` };
    const prepared = await this.prepare(id ? [id] : []);
    if (prepared) return { ok: false, error: prepared };
    this.fallback = id;
    // Only a ChatGPT choice falls back; an OpenRouter one keeps its own model.
    if (this.config.provider === "chatgpt") this.config.model = this.currentFallback();
    writeWorkspaceState(this.stateDir, { fallbackModel: id ?? undefined });
    return { ok: true };
  }

  /** Registers `preparer`, which readies extra OpenRouter ids before a choice switches to them. */
  onPrepare(preparer: (ids: string[]) => Promise<void>): () => void {
    this.preparers.add(preparer);
    return () => this.preparers.delete(preparer);
  }

  /** `!model`'s reply: the current choice and the list. */
  describe(answering?: string | null): string {
    const cur = this.current();
    const lines = [
      cur ? `Model: **${cur.alias}** (${label(cur)})` : `Model: the configured default (${this.config.provider === "chatgpt" ? `chatgpt:${this.config.chatgptModel}` : `openrouter:${this.config.model}`})`,
      ...(cur?.backend === "openrouter" ? [] : [`Falls back to OpenRouter \`${this.currentFallback()}\` while ChatGPT is unavailable.`]),
      ...(answering ? [`Last answer came from ${answering}.`] : []),
      "",
      ...this.list.map((e) => `${e.alias === cur?.alias ? "▸" : "·"} \`${e.alias}\` — ${label(e)}`),
      "",
      "Switch with `!model <alias>` or `!model <openrouter id>`; it applies from the next turn.",
    ];
    return lines.join("\n");
  }

  /** An error message when a live session couldn't ready `ids`, else null. */
  private async prepare(ids: string[]): Promise<string | null> {
    const all = [...new Set([...this.openrouterIds(), ...ids])];
    const results = await Promise.allSettled([...this.preparers].map((p) => p(all)));
    const failed = results.find((r) => r.status === "rejected");
    return failed ? `couldn't load that model: ${String((failed as PromiseRejectedResult).reason).slice(0, 200)}` : null;
  }

  /** A listed OpenRouter entry with this id, so a pick by id lands on the list's alias; else a custom one. */
  private entryFor(id: string): ModelEntry {
    return this.list.find((e) => e.backend === "openrouter" && e.id === id) ?? custom(id);
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
      c.model = this.currentFallback();
    } else {
      c.provider = "openrouter";
      c.chatgptModel = this.base.chatgptModel;
      c.model = entry.id;
    }
  }
}

/** "vendor/model", optionally with a ":variant"; what OpenRouter's catalog ids look like. */
export const OPENROUTER_ID_RE = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/** An OpenRouter id a live chat can use: `:batch` variants answer asynchronously, at a discount, never in a turn. */
export function isChatModelId(id: string): boolean {
  // `:free` variants are rate-limited and mostly need prompt logging, which the agent's requests refuse.
  return OPENROUTER_ID_RE.test(id) && !/:(batch|free)$/i.test(id);
}

function custom(id: string): ModelEntry {
  return { alias: id, backend: "openrouter", id };
}

function label(e: ModelEntry): string {
  return e.backend === "chatgpt" ? `ChatGPT ${e.id} (OpenRouter fallback)` : `OpenRouter ${e.id} (pinned)`;
}
