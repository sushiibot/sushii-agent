// ToolResult (contracts.ts §7) is `{ content: string }` — no side channel for a paused
// interaction. ask_question and the automod approval tools need one anyway, so entries that
// produce a PendingInteraction push it here; the loop (U1) drains the sink after running tools,
// the same way the old runTools special-cased these tool names inline. Additive, outside
// ToolContext, so it doesn't touch the frozen contract.
import type { PendingInteraction } from "../contracts.ts";

export interface PendingInteractionSink {
  push(pending: PendingInteraction): void;
}

/** Same problem for inspect_image: live image URLs need to reach the next model turn as
 *  attachments, not as text content. */
export interface ImageSink {
  push(urls: string[]): void;
}

/** Ports extractUsers (old moderation/executor.ts) — tools that surface author identities
 *  (message rows, audit log entries) feed them here so TurnState.knownUsers (contracts.ts §3,
 *  "seeded + grown") actually grows. */
export interface KnownUsersSink {
  add(userId: string, names: { username: string | null; displayName: string | null }): void;
}

// Augmenting ToolContext (not forking ToolEntry) so every entry's ctx picks this up for free.
// Optional: tools that never pause / never attach images / never discover users don't need to
// know these exist.
declare module "../contracts.ts" {
  interface ToolContext {
    pending?: PendingInteractionSink;
    images?: ImageSink;
    knownUsers?: KnownUsersSink;
  }
}
