import type { AgentSession, ContextEditEntryDraft, ExtensionFactory, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { summarizeToolArgs } from "../agentRuntime/piShared.ts";

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/** Pi triggers compaction at `contextWindow - reserveTokens`; the trigger is capped at this share of the window. */
export const COMPACT_MAX_FILL = 0.75;

/** reserveTokens that puts Pi's compaction trigger at `compactTokens`, at most COMPACT_MAX_FILL of the window.
 *  Not floored at the model's maxTokens: ChatGPT models declare 128K of a 272K window, which would pull the
 *  trigger far below `compactTokens`; Pi's overflow recovery covers a rare reply that doesn't fit. */
export function reserveTokensFor(contextWindow: number, compactTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw new Error(`Cannot auto-compact: unknown model context window (${contextWindow})`);
  return contextWindow - Math.min(compactTokens, Math.floor(contextWindow * COMPACT_MAX_FILL));
}

/** Every session uses a model-specific trigger, including after backend fallback. */
export function autoCompactionSettings(
  models: readonly { provider: string; id: string; contextWindow: number }[],
) {
  if (!models.length) throw new Error("Cannot auto-compact without a model");
  const modelOverrides = Object.fromEntries(
    models.map((m) => [
      `${m.provider}/${m.id}`,
      {
        reserveTokens: reserveTokensFor(m.contextWindow, Infinity),
        keepRecentTokens: Math.min(20_000, Math.floor(m.contextWindow * 0.1)),
      },
    ]),
  );
  return {
    enabled: true,
    ...modelOverrides[`${models[0]!.provider}/${models[0]!.id}`]!,
    modelOverrides,
  };
}

// ── Hygiene: clear old tool output without an LLM call. ──

export const HYGIENE_KEEP_RESULTS = 8;
export const HYGIENE_KEEP_USER_TURNS = 3;
/** A stub is ~100 chars; clearing anything shorter saves nothing and still rewrites the prefix. */
export const HYGIENE_MIN_CHARS = 600;
export const CLEARED_PREFIX = "[tool output cleared:";

export interface HygienePlan {
  drafts: ContextEditEntryDraft[];
  clearedChars: number;
}

type Msg = { role?: string; content?: unknown; toolCallId?: string; toolName?: string };

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === "text" && typeof c.text === "string") n += c.text.length;
    else if (c?.type === "image") n += 4800;
  }
  return n;
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const t = content.find((c) => c?.type === "text" && typeof c.text === "string");
  return t ? (t.text as string) : "";
}

export function clearedStub(tool: string, args: string, chars: number): string {
  const shortArgs = args.replace(/\s+/g, " ").trim();
  const clipped = shortArgs.length > 80 ? `${shortArgs.slice(0, 79)}…` : shortArgs;
  return `${CLEARED_PREFIX} ${tool}${clipped ? ` ${clipped}` : ""}, ${chars} chars — rerun if needed]`;
}

/**
 * Context edits that stub every tool result except the last `keepResults` and anything in the last
 * `keepUserTurns` user turns. Already-cleared and short results are left alone.
 */
export function planHygiene(entries: readonly ProjectedSessionEntry[], opts: { keepResults?: number; keepUserTurns?: number; minChars?: number } = {}): HygienePlan {
  const keepResults = opts.keepResults ?? HYGIENE_KEEP_RESULTS;
  const keepUserTurns = opts.keepUserTurns ?? HYGIENE_KEEP_USER_TURNS;
  const minChars = opts.minChars ?? HYGIENE_MIN_CHARS;
  const calls = new Map<string, { name: string; args: string }>();
  const results: Array<{ index: number; entryId: string; msg: Msg }> = [];
  const userTurns: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.sourceEntry.type !== "message") return;
    for (const m of entry.messages as Msg[]) {
      if (m.role === "user") userTurns.push(index);
      else if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content) if (c?.type === "toolCall") calls.set(c.id, { name: c.name, args: summarizeToolArgs(c.arguments) });
      } else if (m.role === "toolResult") results.push({ index, entryId: entry.sourceEntry.id, msg: m });
    }
  });
  const turnFloor = userTurns.length >= keepUserTurns ? userTurns[userTurns.length - keepUserTurns]! : -1;
  const drafts: ContextEditEntryDraft[] = [];
  let clearedChars = 0;
  for (const r of results.slice(0, Math.max(0, results.length - keepResults))) {
    if (r.index >= turnFloor) continue;
    const chars = textLength(r.msg.content);
    if (chars < minChars || firstText(r.msg.content).startsWith(CLEARED_PREFIX)) continue;
    const call = r.msg.toolCallId ? calls.get(r.msg.toolCallId) : undefined;
    const stub = clearedStub(call?.name ?? r.msg.toolName ?? "tool", call?.args ?? "", chars);
    drafts.push({ type: "context_edit", targetId: r.entryId, replacement: { content: [{ type: "text", text: stub }] } });
    clearedChars += chars;
  }
  return { drafts, clearedChars };
}

/** Survives session.reload(), which re-runs extension factories. */
export interface HygieneState {
  /** Cleared back to true once the context is under the threshold again. */
  armed: boolean;
}

/**
 * At a turn boundary (after the turn's tool results, before the next model call), once per crossing of
 * `thresholdTokens`: stubs old tool output in one batch, so the prompt prefix is rewritten once.
 */
export function createHygieneExtension(opts: { thresholdTokens: number; state: HygieneState; log: Log; keepResults?: number; keepUserTurns?: number; minChars?: number }): ExtensionFactory {
  return (pi) => {
    pi.on("turn_end", (event, ctx) => {
      const tokens = ctx.getContextUsage()?.tokens;
      if (tokens == null) return undefined;
      if (tokens <= opts.thresholdTokens) {
        opts.state.armed = true;
        return undefined;
      }
      if (!opts.state.armed) return undefined;
      const plan = planHygiene(event.context.contextEntries, opts);
      // Nothing old enough yet: stay armed, so the batch lands once something qualifies.
      if (!plan.drafts.length) return undefined;
      opts.state.armed = false;
      opts.log.info({ tokens, cleared: plan.drafts.length, clearedChars: plan.clearedChars }, "cleared old tool output");
      return { entries: [...event.entries, ...plan.drafts] };
    });
  };
}

// ── Anchored summary: our compaction summary and the rotation recap. ──

export const ANCHORED_SECTIONS = [
  "## Goals",
  "## Decisions (and why)",
  "## drk's preferences learned this session",
  "## Open threads / next steps",
  "## Artifacts (files, repos, PRs, branches touched)",
  "## Pending asks / approvals",
];

export type SummaryKind = "compaction" | "recap";

/** The final user message of the summary/recap request, appended to the live context. */
export function anchoredInstruction(kind: SummaryKind, previous?: string): string {
  const purpose =
    kind === "compaction"
      ? "The conversation is about to be compacted: older messages will be replaced by the summary you write now."
      : "This session is about to end; a fresh session starts from the recap you write now.";
  const lines = [
    "[context summary request — not from drk]",
    `${purpose} Do not call tools and do not reply to drk. Write only the summary, in markdown, with exactly these sections:`,
    "",
    ...ANCHORED_SECTIONS,
    "",
    "Rules:",
    "- Merge, don't regenerate: keep every still-valid item from the previous summary, update what changed, and move resolved items out (a line under Decisions is enough).",
    "- Keep exact values: paths, ids, numbers, names, URLs, message links. Quote drk's own words for preferences and constraints, with their exceptions.",
    "- Open threads: don't duplicate TASKS.md; name the task or project and add only what TASKS.md doesn't say.",
    "- Write \"(none)\" under an empty section. Aim for 500–1500 words; never more than 4000.",
  ];
  if (previous?.trim()) lines.push("", "Previous summary to merge into:", "<previous-summary>", previous.trim(), "</previous-summary>");
  return lines.join("\n");
}

/** Details on our compaction entries, so a later compaction can tell our summary from Pi's. */
export const ANCHORED_DETAILS = { anchored: true } as const;

export function isAnchoredDetails(details: unknown): boolean {
  return (details as { anchored?: unknown } | undefined)?.anchored === true;
}

export interface ContinuationResult {
  text: string;
  usage?: unknown;
}

/**
 * One request that continues `session`'s live context with `instruction` as a last user message: same
 * model, reasoning effort, system prompt, tools and message prefix, and the session id as the cache key,
 * so the provider's prompt cache covers everything but the instruction. Null when the reply is not a
 * plain text answer (a tool call, an error, a cut-off).
 */
export async function continueWithInstruction(session: AgentSession, instruction: string, signal?: AbortSignal): Promise<ContinuationResult | null> {
  const { normalizeContext } = await import("@earendil-works/pi-ai");
  const agent = session.agent;
  const model = session.model;
  if (!model) return null;
  let messages = session.sessionManager.buildSessionProjection().messages;
  if (agent.transformContext) messages = await agent.transformContext(messages, signal);
  const llm = await agent.convertToLlm(messages);
  const context = normalizeContext({ messages: [...llm, { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }] });
  const thinking = session.thinkingLevel;
  const stream = await agent.streamFunction(model, context, {
    ...(thinking && thinking !== "off" ? { reasoning: thinking } : {}),
    sessionId: agent.sessionId,
    ...(agent.onPayload ? { onPayload: agent.onPayload } : {}),
    ...(agent.onResponse ? { onResponse: agent.onResponse } : {}),
    transport: agent.transport,
    ...(agent.thinkingBudgets ? { thinkingBudgets: agent.thinkingBudgets } : {}),
    ...(agent.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: agent.maxRetryDelayMs } : {}),
    ...(signal ? { signal } : {}),
  });
  const result = await stream.result();
  if (result.stopReason !== "stop") return null;
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  if (!text || result.content.some((c) => c.type === "toolCall")) return null;
  return { text, usage: result.usage };
}

/**
 * Supplies our anchored summary in place of Pi's. Falls back to Pi's own summarizer (returns nothing)
 * when the summary request fails. Registered after the compaction handoff: the last result wins.
 */
export function createAnchoredCompactionExtension(opts: {
  summarize: (input: { previous?: string; signal: AbortSignal }) => Promise<ContinuationResult | null>;
  log: Log;
}): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", async (event) => {
      const { preparation } = event;
      try {
        const res = await opts.summarize({ ...(preparation.previousSummary ? { previous: preparation.previousSummary } : {}), signal: event.signal });
        if (!res) {
          opts.log.warn({ reason: event.reason }, "anchored summary came back empty or not as text; Pi summarizes instead");
          return undefined;
        }
        opts.log.info({ reason: event.reason, tokensBefore: preparation.tokensBefore, chars: res.text.length }, "anchored compaction summary ready");
        return {
          compaction: {
            summary: res.text,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            ...(res.usage ? { usage: res.usage as never } : {}),
            details: ANCHORED_DETAILS,
          },
        };
      } catch (err) {
        if (event.signal.aborted) return undefined;
        opts.log.warn({ err, reason: event.reason }, "anchored summary failed; Pi summarizes instead");
        return undefined;
      }
    });
  };
}
