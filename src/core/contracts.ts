// U0 — the frozen multi-surface contract. Types/interfaces only, no logic.
// Every other unit imports from here. Changing a type after units start requires a re-sync.
// Source of truth: claude-notes/tasks/multi-surface/PLAN.md (C1–C17) + planning/01–04.
//
// Structure: identity (§1) · inbound (§2) · turn state (§3) · outbound (§4) · interactive
// pause/resume (§5) · surface extension tiers — capabilities/interceptors/hooks (§6) · tools (§7) ·
// stores (§8) · AgentCore (§9).

import type { ModelMessage } from "ai";
import type { MemoryScope } from "./memory/banks.ts";

export type { MemoryScope } from "./memory/banks.ts";

// ─────────────────────────────────────────────────────────────────────────────
// §1 Identity
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminated tag, open for new surfaces. */
export type SurfaceId = "discord" | "buzz" | (string & {});

/** Replaces the bare Discord `threadId`. THE re-keying primitive. `spaceId` (guildId on Discord)
 *  is deliberately separate from `surface`: a buzz conversation can be scoped to a Discord guild. */
export interface ConversationRef {
  surface: SurfaceId;
  spaceId: string;
  conversationId: string;
  /** Surface declares a private/DM conversation; overrides the spaceId-based personal-space heuristic
   *  for memory scoping. */
  isPrivate?: boolean;
}

/** Stable key for in-memory maps. Unique within a surface; space is a scoping attribute, not identity. */
export function conversationKey(ref: ConversationRef): string {
  return `${ref.surface}:${ref.conversationId}`;
}

/** Replaces `UserNames` + `TriggeringUser`. Platform-neutral author identity. */
export interface AuthorRef {
  surface: SurfaceId;
  userId: string;
  username: string | null;
  displayName?: string | null;
  /** Neutral permission signal the brain reasons about. Surface computes it (roles → this flag). */
  isModerator?: boolean;
  /** Neutral role list for prompt context; ids opaque to the core. Surface-resolved. */
  roles?: { id: string; name: string }[];
}

/** Where a message lives, for prompt context. Neutral shape (ports ChannelContext). */
export interface ChannelRef {
  id: string;
  name: string;
  type: string; // "thread (private)", "text", … — neutral string
  isPrivate: boolean;
  topic?: string | null;
  categoryName?: string | null;
  parentChannelId?: string | null;
  parentChannelName?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 Inbound
// ─────────────────────────────────────────────────────────────────────────────

export interface InboundAttachment {
  kind: "image" | "file";
  url: string; // Discord CDN URL; inspect_image resolves it
  contentType?: string | null;
  /** For re-fetching a fresh signed URL. */
  source?: { conversationId: string; messageId: string };
}

/** Discriminated on `surface`. The typed escape hatch the core forwards but never interprets. */
export type PlatformInbound =
  | { surface: "discord"; autoModTrigger?: AutoModTrigger }
  | { surface: "buzz" }
  | { surface: "slack" };

/** Ports AutoModTriggerContext — present only for the autonomous auto-mod driver. */
export interface AutoModTrigger {
  ruleName: string;
  keyword: string;
  channelId: string;
  content: string;
  /** ID of the silent anchor message send_alert_message edits in place to deliver the final ping. */
  anchorMessageId?: string;
  incidentChannelId?: string;
  triggerMessageId?: string;
}

export interface InboundMessage {
  conversation: ConversationRef;
  author: AuthorRef;
  /** Normalized text, bot-mention already stripped by the surface. */
  text: string;
  mentionedUsers?: AuthorRef[];
  replyTo?: { author: AuthorRef; text: string } | null;
  attachments?: InboundAttachment[];
  channel?: ChannelRef;
  platform?: PlatformInbound;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 Turn state (internal; carries invariants a naive restructure drops)
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnState {
  conversation: ConversationRef;
  /** Owner-gate identity for owner-scoped tools. NULLED permanently the moment a mid-loop message
   *  from a different author is injected. Tools read this via ToolContext.owner, NOT inbound.author. */
  owner: AuthorRef | null;
  /** Seeded + grown; drives the identity note de-dup. */
  knownUsers: Map<string, AuthorRef>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 Outbound (structured — NO pre-rendered platform string)
// ─────────────────────────────────────────────────────────────────────────────

export type ReplySegment =
  | { kind: "text"; text: string } // still carries u:/c:/t:/e:/msg: tokens; surface expands
  | { kind: "separator" }; // was `\n---\n`

export type StopReason = "iterations" | "context";

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  contextLimit: number;
  costUsd?: number; // null when model pricing unknown
}

export interface ToolActivity {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentReply {
  segments: ReplySegment[];
  usage: TurnUsage;
  toolTrace: ToolActivity[];
  stoppedEarly?: StopReason;
  cancelled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 Interactive pause/resume (data-addressed, restart-survivable — never a Promise/closure)
// ─────────────────────────────────────────────────────────────────────────────

export interface AskQuestion {
  question: string; // tokenized; surface renders
  choices: string[];
  /** Only this author may answer (ports triggeredByUserId). */
  authorizedResponder: AuthorRef;
}

/** Discord-specific payload the surface needs to render + apply an approved change. */
export type PlatformApproval = {
  surface: "discord";
  ruleId?: string;
  ruleName?: string;
  keyword?: string;
  /** The rule's keyword_filter AFTER the change (post-add or post-remove) — lets the surface render
   *  the counts + alphabetical neighbor diff at approval time. The apply path re-fetches live. */
  keywordFilterAfter?: string[];
};

export interface ApprovalRequest {
  action: "automod-keyword-add" | "automod-keyword-delete";
  summary: string;
  authorizedResponder: AuthorRef;
  platform: PlatformApproval;
}

export type PendingInteraction =
  | { kind: "question"; payload: AskQuestion }
  | { kind: "approval"; payload: ApprovalRequest };

/** Neutral resumption payload for a paused turn. */
export type TurnResumption =
  | { kind: "question-answer"; choice: string; by: AuthorRef }
  | { kind: "approval"; decision: "approved" | "rejected"; by: AuthorRef; systemMessage?: string };

// ─────────────────────────────────────────────────────────────────────────────
// §6 Surface extension tiers (C9): capabilities (required) · interceptors · hooks (observational)
// ─────────────────────────────────────────────────────────────────────────────

export type PromptSlot =
  | "behavior" | "identity" | "channel" | "triggeringUser"
  | "serverContext" | "memoryIndex" | "emoji" | "threadContext" | "moduleExtras";

export interface RenderContext {
  spaceId: string;
  emojiMap?: Record<string, string>;
}

export interface PromptGuidance {
  /** Slot → content. The CORE owns slot ORDER (cache stability); surfaces only fill. */
  sections: Partial<Record<PromptSlot, string>>;
}

/** Required capability: expands neutral tokens to a surface's native syntax + prompt guidance. */
export interface PlatformRenderer {
  renderText(text: string, ctx: RenderContext): string;
  promptGuidance(ctx: RenderContext): PromptGuidance;
  describeUser(author: AuthorRef): string;
}

/** Static flags — readable at prompt-build time (gate slots) AND delivery time (degradation). */
export interface SurfaceCapabilities {
  richComponents: boolean;
  customEmoji: boolean;
  nativeTimestamps: boolean;
  threads: boolean;
  reactions: boolean;
  progress: boolean;
  interactiveChoices: boolean;
  typing: boolean;
  replyTo: boolean;
}

/** Per-turn prompt inputs the surface supplies; the core folds them into slot assembly at the fixed
 *  slot order (C8). The core supplies the rest itself: identity (selfId/selfName), the triggering
 *  user (turn initiator), server context and the memory index. `ownerSection` (ops-triage) and
 *  `moduleExtras` (auto-mod block) are opaque module-authored strings the core only positions. */
export interface TurnPromptContext {
  channel?: ChannelRef;
  emojiMap?: Record<string, string>;
  /** Frozen-or-fetched thread context; also persisted as `initialThreadContext` on the first turn. */
  threadContext?: string;
  threadChannelId?: string;
  ownerSection?: string;
  moduleExtras?: string[];
  /** Per-space persona, replacing the core's default behavior for this turn (e.g. a moderation
   *  server vs. a general one vs. the owner's DMs, all served by one Discord core). */
  behavior?: string;
  /** No Discord timestamp tokens on this surface; see SystemPromptInputs.plainTimestamps. */
  plainTimestamps?: boolean;
}

/**
 * TIER 1 — Capabilities (required, result-bearing). What the core calls and depends on the return
 * of. Passed per-call so one core instance serves many surfaces concurrently and a process boundary
 * is a matter of stubbing this, not the core.
 */
export interface SurfaceSession {
  readonly capabilities: SurfaceCapabilities;
  readonly renderer: PlatformRenderer;
  readonly selfId: string;
  readonly selfName: string;
  /** Per-turn prompt inputs (C8). Optional — a surface with none (or a headless driver) omits it. */
  promptContext?(): TurnPromptContext;
  /** The actual answer must land. Returns the delivered message id where the surface has one. */
  deliver(reply: AgentReply): Promise<{ messageId?: string }>;
  /** Present a paused interaction. Does NOT return the answer; a resume() re-enters as a fresh turn.
   *  Required whenever `capabilities.interactiveChoices` is true (else the turn deadlocks). */
  presentInteraction?(pending: PendingInteraction): Promise<void>;
  /** Cooperative cancel flag the running loop polls. Absent → never cancelled. */
  isCancelled?(): boolean;
  /** Tool hosts this session provides (C6). Gates which tools are constructable this turn. */
  readonly hosts: ToolHosts;
}

/**
 * TIER 2 — Interceptors (result-bearing, pre-operation, abortive). Run BEFORE an operation and may
 * mutate its input or veto it; the core acts on the return. Only `interceptTool` is wired now
 * (C9/D5); other points are defined-not-built. Distinct NAME from the observe hook (pi discipline).
 */
export interface ToolCallIntercept {
  conversation: ConversationRef;
  owner: AuthorRef | null;
  tool: string;
  input: Record<string, unknown>;
}

export type InterceptResult =
  | { block: true; reason?: string }
  | { block?: false; input?: Record<string, unknown> }; // optionally patched args

export interface Interceptors {
  /** First `block` wins and short-circuits (pi semantics). */
  interceptTool?(call: ToolCallIntercept): InterceptResult | Promise<InterceptResult>;
}

/**
 * TIER 3 — Hooks (observational, fire-and-forget). No return the core acts on; the dispatcher
 * try/catches each so a throwing hook can't break the turn. Reactions ⏳/✅, typing, live progress,
 * and thread-title generation (an onTurnEnd hook) all live here.
 */
export interface TurnEndContext {
  conversation: ConversationRef;
  reply: AgentReply;
  toolUseCount: number;
  userTurnCount: number;
  history: readonly ModelMessage[];
  /** Author of the last user message this turn (the initiator, or a mid-loop interjector if one spoke
   *  last) — the individual-bucket owner the deriver writes derived facts to. */
  authorId: string;
  /** Whether this turn ran in a private (DM) space; selects the DM bank over the per-space bank. */
  isPrivate: boolean;
  /** When the last author resolves to a linked principal: the unified DM write identity + its alias
   *  identity userIds, so the deriver's durable write lands in `sushii-dm-principal-<principalId>`
   *  (mirroring the retrieval scope). Absent for unlinked authors. */
  principalId?: string;
  aliasUserIds?: string[];
}

export interface HookEvents {
  onTurnStart(ctx: { conversation: ConversationRef; author: AuthorRef }): void;
  onToolsDispatched(ctx: { conversation: ConversationRef; tools: ToolActivity[] }): void;
  onInterim(ctx: { conversation: ConversationRef; reply: AgentReply }): void;
  onQueued(ctx: { conversation: ConversationRef; inbound: InboundMessage }): void;
  onConsumed(ctx: { conversation: ConversationRef; inbound: InboundMessage }): void;
  onPaused(ctx: { conversation: ConversationRef; pending: PendingInteraction }): void;
  onTurnEnd(ctx: TurnEndContext): void;
  onCancelled(ctx: { conversation: ConversationRef }): void;
}

export type HookName = keyof HookEvents;

export interface HookBus {
  on<E extends HookName>(event: E, handler: HookEvents[E]): void;
  emit<E extends HookName>(event: E, ...args: Parameters<HookEvents[E]>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 Tools (C6): host-typed — a tool needing a host is unconstructable without it
// ─────────────────────────────────────────────────────────────────────────────

/** Provider-neutral tool definition; U2 maps this to the AI SDK's tool shape. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Base context every tool gets. NO discord.js here. */
/** A tool can request that THIS conversation's stored history be cleared. The reset is applied by
 *  agentCore AFTER the turn (so it survives the normal end-of-turn save), which then persists an
 *  empty history instead of the turn's messages. Durable memory (SpaceMemoryStore) is untouched. */
export interface ResetSink {
  request(): void;
}

export interface ToolContext {
  space: { surface: SurfaceId; spaceId: string };
  /** Whether this turn runs in a private/DM context — threaded into execution authz's
   *  personal-space check (a Slack DM's spaceId is the teamId, not "dm", so a space-string test
   *  can't infer it). */
  isPrivate?: boolean;
  /** One per loop run (fresh inbound or resume) — lets a tool require that a confirmation came
   *  after the user saw the previous turn's reply. Mid-loop injections don't change it: the user
   *  hasn't seen this turn's reply yet. */
  turnId?: string;
  owner: AuthorRef | null; // tainted owner-gate identity, NOT inbound.author
  store: ConversationStore;
  memory: SpaceMemoryStore;
  reset?: ResetSink;
  log: unknown; // Logger; typed loosely to avoid coupling U0 to the logger module
}

// Host interfaces are declared here to pin the SHAPE; U2 populates their members via module
// augmentation (tools/hosts.ts) as it converts the concrete tools. A tool that reaches for a
// host it doesn't require won't type-check.
export interface DiscordToolHost {}
export interface MessageCacheHost {}
export interface SushiMcpHost {}
export interface FsHost {}

export interface ToolHosts {
  discord?: DiscordToolHost;
  messageCache?: MessageCacheHost;
  mcp?: SushiMcpHost;
  /** A read-only, root-scoped filesystem the agent can browse (list/search/read). Provided per space
   *  when there's reference material to expose — currently the wiki-sync knowledge base. */
  fs?: FsHost;
}

export interface ToolResult {
  content: string;
}

export interface ToolEntry<H extends keyof ToolHosts = never> {
  name: string;
  definition: ToolDefinition;
  /** Hosts this tool needs; if any is absent for the session, the tool is not registered. */
  requiresHosts: readonly H[];
  /** Surface capabilities this tool needs (e.g. ask_question needs `interactiveChoices`). */
  requiresCapabilities?: readonly (keyof SurfaceCapabilities)[];
  execute(
    input: Record<string, unknown>,
    ctx: ToolContext & Required<Pick<ToolHosts, H>>,
  ): Promise<ToolResult>;
}

export interface ToolRegistry {
  /** Assemble the per-turn tool set given the session's hosts + capabilities + config/mode gates.
   *  `autoMod` mirrors the old resolveToolEntries(enabledModules, autoModMode) signal — restricts
   *  timeout_member/delete_user_messages/send_alert_message to the autonomous auto-mod driver. */
  resolve(
    session: SurfaceSession,
    space: {
      surface: SurfaceId;
      spaceId: string;
      autoMod?: boolean;
      /** Author-aware owner-DM gating (runner + update_profile tools). When the principal registry is
       *  configured these decide visibility; unconfigured falls back to the space-string heuristic. */
      isOwner?: boolean;
      isPrivate?: boolean;
      /** Whether the caller is authorized for this space (owner OR a community-trusted member). Gates
       *  runner + ops-triage tool visibility in the configured regime; update_profile stays isOwner. */
      authorized?: boolean;
    },
  ): ToolEntry<keyof ToolHosts>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 Stores (re-keyed by ConversationRef / spaceId)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationData {
  messages: ModelMessage[];
  initialThreadContext: string | null;
}

export interface ConversationStore {
  load(ref: ConversationRef): ConversationData;
  save(ref: ConversationRef, data: ConversationData): void;
  deleteStale(maxAgeMs: number): void;
}

export interface MemoryEntry {
  id: number;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface SpaceMemoryStore {
  getServerContext(spaceId: string): string | null;
  setServerContext(spaceId: string, content: string): void;
  listTitles(spaceId: string): string[];
  count(spaceId: string): number;
  read(spaceId: string, title: string): MemoryEntry | null;
  search(spaceId: string, query: string, limit?: number): MemoryEntry[];
  upsert(spaceId: string, title: string, content: string): { ok: true } | { error: string };
  delete(spaceId: string, title: string): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8b Context management — compaction (transient) + proactive memory (durable)
// Two orthogonal layers, both optional on AgentCoreDeps. Compaction keeps ONE
// conversation's transcript under the token budget; MemoryProvider injects durable
// cross-session facts every turn. Pinned contracts — parallel units implement these.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompactionOutcome {
  /** The history to run the turn against — rewritten (older turns folded into a summary) when
   *  `compacted`, else the input unchanged. MUST preserve tool-call/tool-result pairing: never
   *  return a tool-result message whose originating tool-call is no longer present, or the model
   *  API rejects the history (orphaned tool_call_id). Fold only on clean turn boundaries. */
  messages: ModelMessage[];
  compacted: boolean;
  /** Durable-fact candidates surfaced by the fold, for the caller to forward to
   *  MemoryProvider.remember (the "compaction is the deriver" hook). Empty when nothing folded. */
  factCandidates: string[];
}

export interface Compactor {
  /** Called at turn load with the persisted history, BEFORE the new user turn is appended. If the
   *  history is over budget, fold; else return it unchanged with `compacted:false`. */
  maybeCompact(input: { messages: ModelMessage[]; contextLimit: number }): Promise<CompactionOutcome>;
}

export interface MemoryProvider {
  /** Per-turn retrieval keyed to the incoming user text. Best-effort and NON-BLOCKING: the caller
   *  races this against `deadlineMs` and injects nothing if it doesn't resolve in time, so memory
   *  can never add latency to a reply. Return a rendered, token-bounded block to inject, or null
   *  when nothing is relevant / not ready. The impl owns any embedding cache / recency fast-path. */
  retrieve(input: { scope: MemoryScope; query: string; deadlineMs: number; tokenBudget?: number }): Promise<string | null>;
  /** Persist one curated, NON-AUTHORITATIVE durable fact (decisions/preferences/standing context —
   *  not dated authoritative data that lives in source tools). Writes to the individual bucket. */
  remember(input: { scope: MemoryScope; text: string; importance?: number }): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 AgentCore — the in-process door a surface (or a headless driver) calls
// ─────────────────────────────────────────────────────────────────────────────

export type CancelOutcome =
  | { status: "cancelling" }
  | { status: "no-active-turn" }
  | { status: "forbidden"; owner: AuthorRef };

export type AgentTurnResult =
  | { status: "completed"; reply: AgentReply }
  | { status: "queued" } // mid-loop injection accepted
  | { status: "paused"; pending: PendingInteraction }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface AgentCore {
  /** Primary entry. The core decides queue-or-run internally; delivery happens through `session`,
   *  the returned result is for the surface's own lifecycle/persistence decisions (no second render). */
  handleInbound(inbound: InboundMessage, session: SurfaceSession): Promise<AgentTurnResult>;
  /** Resume a turn paused on ask_question / approval. */
  resume(conversation: ConversationRef, resumption: TurnResumption, session: SurfaceSession): Promise<AgentTurnResult>;
  /** Cooperative cancel; only the triggering author may stop a turn. */
  cancel(conversation: ConversationRef, byAuthor: AuthorRef): CancelOutcome;
}

/** Provider-neutral language model handle; U1 binds the concrete AI-SDK provider. */
export interface LanguageModelProvider {
  readonly modelId: string;
  /** The model's absolute context window size, in tokens (e.g. config.openaiContextLimit at wiring). */
  readonly contextLimit: number;
}

export interface LoopLimits {
  maxIterations: number;
  contextRatio: number;
}

export interface AgentCoreDeps {
  model: LanguageModelProvider;
  store: ConversationStore;
  memory: SpaceMemoryStore;
  tools: ToolRegistry;
  interceptors?: Interceptors;
  hooks: HookBus;
  behavior: string;
  limits?: LoopLimits;
  /** Transient transcript compaction (summarize-fold). When absent, no compaction runs. */
  compactor?: Compactor;
  /** Durable cross-session memory, proactively injected each turn. When absent, none injected. */
  memoryProvider?: MemoryProvider;
  /** What the turn's initiator can have the agent do beyond its tools (runners, ops), as system prompt
   *  text. Gated per initiator + space, so it matches the tools that check the same thing. */
  capabilitySections?: (turn: {
    surface: string;
    spaceId: string;
    userId: string;
    isPrivate: boolean;
    isOwner: boolean;
    /** Names of the tools resolved for this turn. */
    tools: string[];
  }) => string | undefined;
}
