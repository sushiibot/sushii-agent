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
  private readonly listeners = new Set<() => Promise<void>>();
  private pending: Promise<unknown> = Promise.resolve();

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
        ? custom(saved.customModel)
        : typeof saved?.modelAlias === "string"
          ? this.find(saved.modelAlias)
          : undefined;
    if (entry) this.apply(entry);
    else if (this.fallback) this.config.model = this.currentFallback();
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

  /** `target` is a list alias, or any OpenRouter model id ("vendor/model"). */
  select(target: string): ModelSwitch {
    const entry = this.find(target) ?? (isChatModelId(target.trim()) ? custom(target.trim()) : undefined);
    if (!entry) return { ok: false, error: `unknown model "${target}"; choose one of ${this.list.map((e) => e.alias).join(", ")}, or an OpenRouter id like deepseek/deepseek-v4-pro` };
    const changed = this.current()?.alias !== entry.alias;
    this.apply(entry);
    const listed = this.list.includes(entry);
    writeWorkspaceState(this.stateDir, { modelAlias: listed ? entry.alias : undefined, customModel: listed ? undefined : entry.id });
    this.notify();
    return { ok: true, entry, changed };
  }

  /** Sets the OpenRouter model a ChatGPT choice falls back to; null goes back to the configured one. */
  selectFallback(id: string | null): { ok: true } | { ok: false; error: string } {
    if (id !== null && !isChatModelId(id)) return { ok: false, error: `"${id}" isn't an OpenRouter model a chat can use` };
    this.fallback = id;
    if (this.current()?.backend !== "openrouter") this.config.model = this.currentFallback();
    writeWorkspaceState(this.stateDir, { fallbackModel: id ?? undefined });
    this.notify();
    return { ok: true };
  }

  /** Runs `listener` after every change; returns its unsubscribe. */
  onChange(listener: () => Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once the listeners of the latest change have run, e.g. a live session registering the model. */
  settled(): Promise<void> {
    return this.pending.then(() => undefined);
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

  private notify(): void {
    const run = Promise.allSettled([...this.listeners].map((l) => l()));
    this.pending = this.pending.then(() => run);
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
  return OPENROUTER_ID_RE.test(id) && !/:batch$/i.test(id);
}

function custom(id: string): ModelEntry {
  return { alias: id, backend: "openrouter", id };
}

function label(e: ModelEntry): string {
  return e.backend === "chatgpt" ? `ChatGPT ${e.id} (OpenRouter fallback)` : `OpenRouter ${e.id} (pinned)`;
}
