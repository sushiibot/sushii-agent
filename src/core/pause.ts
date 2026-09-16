import type { PendingInteraction } from "./contracts.ts";

/**
 * Thrown by a tool's `execute()` to pause the turn (ask_question, automod approvals). U0's
 * `ToolResult` is a plain `{ content }` string with no discriminant for control flow, so a tool
 * that needs to pause signals it this way instead. The loop dispatch site is the only catcher.
 */
export class ToolPause extends Error {
  constructor(public readonly pending: PendingInteraction) {
    super("tool paused the turn");
  }
}
