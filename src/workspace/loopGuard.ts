import { createHash } from "node:crypto";
import type { ExtensionFactory, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { bashChangedRepo } from "./verifyGate.ts";

export const LOOP_GUARD_CUSTOM_TYPE = "sushii-loop-guard";
/** The repeat that gets blocked: the third identical call. */
export const REPEAT_LIMIT = 3;
/** Blocks in one run before the agent is told to stop and summarize. */
export const NUDGE_AFTER_BLOCKS = 2;

export const LOOP_NUDGE =
  "Several repeated calls have been blocked this run. Stop retrying: summarize for drk what you tried, what's failing, and what you need.";

type Log = { warn: (obj: object, msg: string) => void };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Identity of a call: bash by its whitespace-normalized command (timeout ignored), other tools by their key-sorted args. */
export function callKey(toolName: string, input: Record<string, unknown>): string {
  const args = toolName === "bash" && typeof input.command === "string" ? input.command.trim().replace(/\s+/g, " ") : JSON.stringify(stable(input));
  return createHash("sha256").update(`${toolName}\0${args}`).digest("hex");
}

export function repeatReason(times: number): string {
  return `You've repeated this exact call ${times} times; change approach or explain what's blocking you.`;
}

/**
 * Blocks the third identical tool call in a run. Counts reset when code changes, so an
 * edit-then-rerun-the-tests cycle is never blocked.
 */
export function createLoopGuardExtension(opts: { log?: Log } = {}): ExtensionFactory {
  return (pi) => {
    let counts = new Map<string, number>();
    let blocks = 0;
    let nudged = false;

    pi.on("before_agent_start", () => {
      counts = new Map();
      blocks = 0;
      nudged = false;
    });

    pi.on("tool_call", (event): ToolCallEventResult | undefined => {
      const input = event.input as Record<string, unknown>;
      const key = callKey(event.toolName, input);
      const prior = counts.get(key) ?? 0;
      if (prior + 1 < REPEAT_LIMIT) {
        counts.set(key, prior + 1);
        return undefined;
      }
      blocks++;
      opts.log?.warn({ tool: event.toolName, times: prior, blocks }, "loop guard blocked a repeated call");
      if (blocks >= NUDGE_AFTER_BLOCKS && !nudged) {
        nudged = true;
        pi.sendMessage({ customType: LOOP_GUARD_CUSTOM_TYPE, content: LOOP_NUDGE, display: false }, { deliverAs: "steer" });
      }
      return { block: true, reason: repeatReason(prior) };
    });

    pi.on("tool_result", (event) => {
      if (event.isError) return;
      const changed =
        event.toolName === "edit" ||
        event.toolName === "write" ||
        (event.toolName === "bash" && typeof event.input.command === "string" && bashChangedRepo(event.input.command) !== null);
      if (changed) counts = new Map();
    });
  };
}

