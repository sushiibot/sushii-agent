import {
  MODELS_MAX,
  RPC_METHODS,
  chatCommandParams,
  modelsGetParams,
  modelsSetParams,
  type ChatCommandParams,
  type ChatCommandResult,
  type ModelsResult,
} from "../orchestration/contracts.ts";
import type { ModelChoice } from "./modelChoice.ts";

export interface CommandDeps {
  principalId: string;
  /** `!compact`: flush, compact, reload; tokens before/after or why it didn't. */
  compact(): Promise<{ tokensBefore: number; tokensAfter: number | null } | { error: string }>;
  choice: ModelChoice;
  /** The main session's model right now, as the footer names it. */
  currentModel?(): string | null;
  /** `!tasks [project]`, read straight from the files. */
  tasks(arg?: string): string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Owner commands the workspace answers without the model; the bot's router sends them as chat/command. */
export async function runCommand(params: ChatCommandParams, deps: CommandDeps): Promise<ChatCommandResult> {
  switch (params.command) {
    case "compact": {
      const res = await deps.compact();
      if ("error" in res) return { text: `Didn't compact: ${res.error}` };
      return { text: `🗜️ Compacted: ${fmt(res.tokensBefore)} → ${res.tokensAfter === null ? "?" : `~${fmt(res.tokensAfter)}`} tokens.` };
    }
    case "model": {
      if (!params.args) return { text: deps.choice.describe(deps.currentModel?.() ?? null) };
      const res = deps.choice.select(params.args);
      if (!res.ok) return { text: res.error };
      const e = res.entry;
      const where = e.backend === "chatgpt" ? `ChatGPT \`${e.id}\` (OpenRouter while ChatGPT is unavailable)` : `OpenRouter \`${e.id}\``;
      return { text: res.changed ? `Model set to **${e.alias}**: ${where}, from the next turn.` : `Already on **${e.alias}** (${where}).` };
    }
    case "tasks":
      return { text: deps.tasks(params.args) };
  }
}

function models(choice: ModelChoice): ModelsResult {
  return {
    current: choice.current()?.alias ?? null,
    models: choice.list.slice(0, MODELS_MAX).map((e) => ({ alias: e.alias, backend: e.backend, id: e.id })),
  };
}

export function commandHandlers(deps: CommandDeps): Record<string, (params: unknown) => Promise<unknown>> {
  const checkPrincipal = (principalId: string) => {
    if (principalId !== deps.principalId) throw new Error(`principal mismatch: this workspace serves ${deps.principalId}, got ${principalId}`);
  };
  return {
    [RPC_METHODS.modelsGet]: async (p) => {
      checkPrincipal(modelsGetParams.parse(p).principalId);
      return models(deps.choice);
    },
    // Same as `!model <alias>`: it applies from the next turn.
    [RPC_METHODS.modelsSet]: async (p) => {
      const params = modelsSetParams.parse(p);
      checkPrincipal(params.principalId);
      const res = deps.choice.select(params.alias);
      if (!res.ok) throw new Error(res.error);
      return models(deps.choice);
    },
    [RPC_METHODS.chatCommand]: async (p) => {
      const params = chatCommandParams.parse(p);
      if (params.principalId !== deps.principalId) throw new Error(`principal mismatch: this workspace serves ${deps.principalId}, got ${params.principalId}`);
      return runCommand(params, deps);
    },
  };
}
