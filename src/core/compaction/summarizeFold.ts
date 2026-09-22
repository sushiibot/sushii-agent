import type { ModelMessage } from "ai";
import type { Compactor, CompactionOutcome } from "../contracts.ts";

export interface SummarizeFoldOptions {
  /** Folds a run of older turns into one summary string. Injected so tests need no real LLM. */
  summarize: (messages: ModelMessage[]) => Promise<string>;
  /** Turns kept verbatim at the tail. A turn = a `user` message plus the assistant/tool messages up
   *  to the next `user`. */
  tailTurns?: number;
  /** Fold when estimated tokens reach `contextLimit * ratio`. Default sits below the 0.85 force-wrap. */
  ratio?: number;
}

/** Approximate: JSON length / 4 chars-per-token. Good enough to trigger a fold well before the wall. */
function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Default summarize-fold compactor. Folds only on `user`-turn boundaries, which keeps every
 *  assistant tool-call together with its `tool` result(s) — a tail that begins at a `user` message
 *  can never orphan a `tool_call_id`. */
export function createSummarizeFoldCompactor(opts: SummarizeFoldOptions): Compactor {
  const tailTurns = opts.tailTurns ?? 10;
  const ratio = opts.ratio ?? 0.6;

  return {
    async maybeCompact({ messages, contextLimit }): Promise<CompactionOutcome> {
      if (estimateTokens(messages) < contextLimit * ratio) {
        return { messages, compacted: false, factCandidates: [] };
      }

      const userTurnStarts: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user") userTurnStarts.push(i);
      }

      const foldBoundary =
        userTurnStarts.length > tailTurns
          ? userTurnStarts[userTurnStarts.length - tailTurns]
          : (userTurnStarts[0] ?? 0);

      // Nothing older than the kept tail (single/oversized turn, or no user boundary at all).
      if (foldBoundary <= 0) {
        return { messages, compacted: false, factCandidates: [] };
      }

      const older = messages.slice(0, foldBoundary);
      const tail = messages.slice(foldBoundary);
      const summary = await opts.summarize(older);

      return {
        messages: [{ role: "system", content: summary }, ...tail],
        compacted: true,
        factCandidates: [],
      };
    },
  };
}
