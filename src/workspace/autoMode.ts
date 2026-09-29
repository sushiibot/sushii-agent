import type { ExtensionContext, ExtensionFactory, ModelRuntime, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
  AuditLog,
  SessionState,
  adjudicate,
  buildProtectedSet,
  type AuditRecord,
  type CompletionFn,
} from "../../vendor/pi-verdict/extensions/pi-verdict.ts";

/**
 * Auto mode: pi-verdict's rule floor plus a model judge on the main agent's tool calls. A seatbelt
 * against accidents, not a boundary: the judge sees commands and paths, never file contents or results.
 */

type JudgeModel = NonNullable<ExtensionContext["model"]>;
type UserRules = NonNullable<ConstructorParameters<typeof SessionState>[1]>;
type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

export const JUDGE_PROVIDER_ID = "sushii-workspace-judge";
const JUDGE_CONTEXT_WINDOW = 128_000;
// Room for low-effort reasoning before the <verdict> line; pi-verdict's own 512/1024 budget can end empty.
const JUDGE_MAX_TOKENS = 2000;
const LOG_REASON_MAX = 160;
const ASK_ACTION_MAX = 1500;

/** Tools the judge never sees: Pi's read-only built-ins, the bot-proxied lookups, and bot tools the bot gates itself. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_url_content",
  "search_logs",
  "get_trace",
  "get_issue_status",
  "list_triaged_issues",
  "team_config",
  // The bot already asks drk before running this one; judging it too would prompt twice.
  "file_linear_issue",
]);

// pi-verdict's user rules, fixed here instead of its config file (which it would write under ~/.pi/agent).
const RULES: UserRules = {
  allow: [],
  deny: [],
  denyPaths: [],
  ignoreTools: [],
  builtinDenyFloor: true,
  classifierModel: null,
  toggleShortcut: null,
  audit: false,
  notifyAllows: false,
  classifierMinConfidence: null,
  classifierFallbackModel: null,
  classifierFallbackMode: "enforce",
};

/** Registers the judge as its own OpenRouter provider on `runtime`, so the chat model's provider stays untouched. */
export function registerJudgeModel(runtime: ModelRuntime, opts: { model: string; apiKey: string; baseUrl: string }): JudgeModel {
  runtime.registerProvider(JUDGE_PROVIDER_ID, {
    name: "sushii workspace auto-mode judge",
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    api: "openai-completions",
    models: [
      {
        id: opts.model,
        name: opts.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: JUDGE_CONTEXT_WINDOW,
        maxTokens: JUDGE_MAX_TOKENS,
        // Merged into the request body as-is; Pi only emits reasoning params for models flagged reasoning.
        samplingParams: { provider: { data_collection: "deny" }, reasoning: { effort: "low" } },
      },
    ],
  });
  const model = runtime.getModel(JUDGE_PROVIDER_ID, opts.model);
  if (!model) throw new Error(`auto-mode judge ${JUDGE_PROVIDER_ID}/${opts.model} failed to register`);
  return model;
}

/** pi-verdict's completion call on `runtime`, without temperature: Gemini 3 loops on repeated tokens at 0. */
export function judgeCompletion(runtime: Pick<ModelRuntime, "complete">): CompletionFn {
  return async (model, context, options = {}) => {
    const { temperature: _t, ...rest } = options;
    const maxTokens = Math.max(typeof rest.maxTokens === "number" ? rest.maxTokens : 0, JUDGE_MAX_TOKENS);
    const reply = await runtime.complete(model, context as Parameters<ModelRuntime["complete"]>[1], { ...rest, maxTokens });
    return reply as unknown as Awaited<ReturnType<CompletionFn>>;
  };
}

export type AutoModeVerdict = "allow" | "deny" | "ask";
export type AutoModeSource = "rule" | "classifier" | "fail-closed" | "protected-path" | "no-ui";

/** One audit line: never the tool arguments. */
export interface AutoModeAudit {
  tool: string;
  verdict: AutoModeVerdict;
  source: AutoModeSource;
  /** The owner's answer to an ask. */
  answer?: "approved" | "declined";
  reason: string;
  runId: string | null;
}

export interface AutoModeOptions {
  /** null: every judged call fails closed to an ask. */
  judge: JudgeModel | null;
  complete: CompletionFn;
  agentDir: string;
  currentRunId?: () => string | null;
  log: Log;
}

interface Decision {
  verdict: AutoModeVerdict;
  source: AutoModeSource;
  reason: string;
}

class CapturingAudit extends AuditLog {
  readonly records: AuditRecord[] = [];
  constructor() {
    super("");
  }
  override append(record: AuditRecord): void {
    this.records.push(record);
  }
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function actionLine(tool: string, input: Record<string, unknown>): string {
  const detail = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : JSON.stringify(input);
  return clip(`${tool}: ${detail}`, ASK_ACTION_MAX);
}

async function decide(
  prot: ReturnType<typeof buildProtectedSet>,
  opts: AutoModeOptions,
  call: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
): Promise<Decision> {
  const state = new SessionState(prot, RULES, null);
  const audit = new CapturingAudit();
  state.audit = audit;
  const judge = opts.judge;
  // hasUI is always true here: the headless ask → deny degradation happens below, after the mapping.
  const v = await adjudicate(state, call, {
    cwd: ctx.cwd,
    hasUI: true,
    getModel: () => (judge ? { model: judge, thinking: "off" } : null),
    complete: opts.complete,
    host: ctx.sessionManager,
    signal: ctx.signal,
  });
  const record = v.pendingAudit ?? audit.records.at(-1);
  // pi-verdict fails closed to deny; a judge outage should reach the owner instead.
  if (v.verdict === "deny" && record?.source === "fail-closed") return { verdict: "ask", source: "fail-closed", reason: "the judge could not decide" };
  // The regex floor blocks `rm -r`, `git restore` and friends outright; single-user, so the owner can approve them.
  if (v.verdict === "deny" && v.source === "rule" && !v.reason.startsWith("self-protection")) return { verdict: "ask", source: "rule", reason: v.reason };
  if (v.source === "protected-path") return { verdict: v.verdict, source: "protected-path", reason: v.reason };
  return { verdict: v.verdict, source: v.source === "rule" ? "rule" : "classifier", reason: v.reason };
}

function blocked(tool: string, reason: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Auto mode blocked this ${tool} call; it did NOT run. Reason: ${clip(reason, 300) || "none given"}. Tell the owner; find a safer way rather than routing around the block.`,
  };
}

/** The tool_call gate. Read-only tools pass untouched; every other call goes through pi-verdict. */
export function createAutoModeExtension(opts: AutoModeOptions): ExtensionFactory {
  const prot = buildProtectedSet(opts.agentDir, null);
  const runId = () => opts.currentRunId?.() ?? null;
  const record = (a: Omit<AutoModeAudit, "runId">) => {
    const line: AutoModeAudit = { ...a, reason: clip(a.reason, LOG_REASON_MAX), runId: runId() };
    if (a.verdict === "allow") opts.log.info(line, "auto-mode verdict");
    else opts.log.warn(line, "auto-mode verdict");
  };

  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (READ_ONLY_TOOLS.has(event.toolName)) return undefined;
      const tool = event.toolName;
      const input = (event.input ?? {}) as Record<string, unknown>;
      let d: Decision;
      try {
        d = await decide(prot, opts, { toolName: tool, input }, ctx);
      } catch (err) {
        opts.log.warn({ err, tool, runId: runId() }, "auto-mode judge threw; asking the owner");
        d = { verdict: "ask", source: "fail-closed", reason: "the judge could not decide" };
      }
      if (d.verdict === "allow") {
        record({ tool, ...d });
        return undefined;
      }
      if (d.verdict === "deny") {
        record({ tool, ...d });
        return blocked(tool, d.reason);
      }
      if (!ctx.hasUI) {
        record({ tool, verdict: "deny", source: "no-ui", reason: `needs approval, nobody to ask (${d.reason})` });
        return blocked(tool, `needs the owner's approval and no one can be asked here (${d.reason})`);
      }
      const ok = await ctx.ui.confirm("Auto mode: allow this tool call?", `${actionLine(tool, input)}\n\nWhy it's asking: ${clip(d.reason, 300)}`, {
        signal: ctx.signal,
      });
      record({ tool, ...d, answer: ok ? "approved" : "declined" });
      return ok ? undefined : blocked(tool, "the owner declined it");
    });
  };
}
