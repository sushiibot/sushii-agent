import { join, resolve, sep } from "node:path";
import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import { tracer } from "../../telemetry.ts";
import type { WikiRepo } from "./git.ts";
import { commitAndPush } from "./git.ts";
import { findBrokenLinks } from "./linkCheck.ts";
import { WIKI_SYNC_SYSTEM_PROMPT } from "./prompt.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const logger = getLogger("wiki-sync:pi");
const sessionLogger = getLogger("wiki-sync:pi:session");

const PROVIDER_ID = "sushii-openrouter";

// How many times to re-prompt a session that comes back with no text, no thinking, and no tool
// calls at all -- distinct from pi-coding-agent's own auto_retry (which only covers transient
// provider errors like rate limits/overloads). A stop-with-nothing completion isn't retryable by
// that logic since it isn't an error, so left alone the session just ends with nothing done.
const MAX_EMPTY_TURN_RETRIES = 2;
const CONTINUE_NUDGE_PROMPT =
  "Your last response had no text and made no tool calls. If you're not finished, continue working. If you are finished, call commit_and_push (or explain in text why there's nothing to change).";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODEL_METADATA_TIMEOUT_MS = 5000;

/**
 * Looks up the model's real context window from OpenRouter's catalog so wiki-sync tracks
 * the provider's actual limit instead of a hand-checked constant that silently drifts out of
 * sync with it -- which is exactly how the previous hardcoded value ended up above the model's
 * real ceiling. Falls back to config.wikiSync.contextLimit on any fetch/parse failure or if the
 * model isn't listed -- a sweep shouldn't hard-fail just because the catalog endpoint is slow
 * or down.
 */
async function resolveContextWindow(modelId: string): Promise<number> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OpenRouter models catalog returned ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
    const entry = payload.data?.find((m) => m.id === modelId);
    if (!entry?.context_length || entry.context_length <= 0) throw new Error(`model ${modelId} missing context_length in catalog`);
    return entry.context_length;
  } catch (err) {
    logger.warn({ modelId, err, fallback: config.wikiSync.contextLimit }, "failed to resolve context window from OpenRouter catalog, using configured fallback");
    return config.wikiSync.contextLimit;
  }
}

/** Keeps log lines (and Loki structured-metadata fields, which silently drop oversized values) from ballooning on large tool payloads. */
function preview(value: unknown, max = 400): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}… (${str.length} chars total)` : str;
}

/**
 * Everything the Pi session actually does — every tool call, every turn, whether a turn was
 * cut off by the provider's token cap — previously lived only in the on-disk session transcript,
 * invisible to Grafana/Loki. Wired to a dedicated child logger so it's filterable independently
 * of the sparse start/end lines sweep.ts and this file already log.
 */
function logSessionEvent(log: ReturnType<typeof getLogger>, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start":
      log.info("turn started");
      break;
    case "tool_execution_start":
      log.info({ toolCallId: event.toolCallId, toolName: event.toolName, args: preview(event.args) }, "tool call started");
      break;
    case "tool_execution_end":
      log.info(
        { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: preview(event.result) },
        "tool call finished",
      );
      break;
    case "message_update":
      switch (event.assistantMessageEvent.type) {
        case "thinking_end":
          log.info({ content: preview(event.assistantMessageEvent.content) }, "thinking");
          break;
        case "text_end":
          log.info({ content: preview(event.assistantMessageEvent.content) }, "text");
          break;
        // "length" here is the tell for a response getting cut off by the provider's max_tokens
        // cap (see WIKI_SYNC_MAX_OUTPUT_TOKENS) -- previously indistinguishable from a clean
        // "nothing to commit" finish since neither logged anything on their own.
        case "done":
          log.info({ reason: event.assistantMessageEvent.reason }, "turn done");
          break;
        case "error":
          log.error({ reason: event.assistantMessageEvent.reason }, "turn errored");
          break;
      }
      break;
  }
}

// The model's actual creator (per OTel's gen_ai.provider.name registry, which lists "deepseek"
// as a well-known value) -- distinct from PROVIDER_ID, which just names our internal routing
// registration through OpenRouter and has no standard slot to go in.
const GEN_AI_PROVIDER_NAME = "deepseek";

/**
 * Mirrors session events into OTel child spans nested under the caller's active span (the
 * "invoke_agent" span from sweep.ts, via ambient AsyncLocalStorage context -- no context
 * threading needed here). A span only exports once it *ends*, so the still-open parent span
 * alone gives no in-flight visibility; per-turn and per-tool-call spans do, since each closes
 * and exports within seconds even while the sweep as a whole is still running.
 *
 * Span/attribute names follow the OpenTelemetry GenAI semantic conventions (still
 * "Development" stability as of this writing -- see
 * github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
 * and gen-ai-agent-spans.md): a "chat" span per model turn, an "execute_tool" span per tool
 * call. The spec has no concept of a "turn" as distinct from "chat" -- one chat span per model
 * completion is the closest standard fit for what this harness calls a turn.
 *
 * Deliberately excludes prompt/completion/tool-argument content from span attributes (sizes
 * only) -- traces are lower-friction to query/aggregate across than logs, so anything sensitive
 * belongs in the logs (already truncated there) rather than duplicated here.
 */
function createSessionSpans() {
  const toolSpans = new Map<string, Span>();
  let turnSpan: Span | null = null;

  function endTurn(usage: { input: number; output: number } | undefined, finishReason: string, isError: boolean): void {
    if (!turnSpan) return;
    turnSpan.setAttribute("gen_ai.response.finish_reasons", [finishReason]);
    if (usage) {
      turnSpan.setAttribute("gen_ai.usage.input_tokens", usage.input);
      turnSpan.setAttribute("gen_ai.usage.output_tokens", usage.output);
    }
    if (isError) {
      turnSpan.setAttribute("error.type", "_OTHER");
      turnSpan.setStatus({ code: SpanStatusCode.ERROR });
    }
  }

  return {
    handle(event: AgentSessionEvent): void {
      switch (event.type) {
        case "turn_start":
          turnSpan = tracer.startSpan(`chat ${config.wikiSync.model}`, {
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": config.wikiSync.model,
              "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
            },
          });
          break;
        case "turn_end":
          turnSpan?.end();
          turnSpan = null;
          break;
        case "tool_execution_start":
          toolSpans.set(
            event.toolCallId,
            tracer.startSpan("execute_tool", {
              attributes: {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": event.toolName,
                "gen_ai.tool.call.id": event.toolCallId,
              },
            }),
          );
          break;
        case "tool_execution_end": {
          const span = toolSpans.get(event.toolCallId);
          if (span) {
            if (event.isError) {
              span.setAttribute("error.type", "_OTHER");
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
            span.end();
            toolSpans.delete(event.toolCallId);
          }
          break;
        }
        case "message_update":
          // "length" is the max_tokens-truncation tell -- see WIKI_SYNC_MAX_OUTPUT_TOKENS.
          if (event.assistantMessageEvent.type === "done") {
            const { reason, message } = event.assistantMessageEvent;
            endTurn(message.usage, reason, false);
          } else if (event.assistantMessageEvent.type === "error") {
            const { reason, error } = event.assistantMessageEvent;
            endTurn(error.usage, reason, true);
          }
          break;
      }
    },
    /** Safety net: closes any span left open by an error path that skips its matching *_end event. */
    endAll(): void {
      turnSpan?.end();
      turnSpan = null;
      for (const span of toolSpans.values()) span.end();
      toolSpans.clear();
    },
  };
}

export interface WikiSyncRunResult {
  finalText: string;
  commitSha: string | null;
}

/**
 * Runs one Pi coding-agent turn against the wiki repo checkout. Imports the SDK lazily so its
 * ~14MB of transitive deps only load for guilds that actually have wiki-sync enabled.
 */
export async function runWikiSyncSession(opts: { repo: WikiRepo; prompt: string; guildId: string; runId: string }): Promise<WikiSyncRunResult> {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, defineTool } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { Type } = await import("typebox");

  let commitSha: string | null = null;
  // Whether the sweep saw an actual commit/push failure (vs. legitimately nothing to commit).
  // sweep.ts only advances its watermark past a batch of messages once the session finishes
  // without one of these — a push failure must not look identical to "nothing changed".
  let commitError: Error | null = null;

  const commitAndPushTool = defineTool({
    name: "commit_and_push",
    label: "Commit & Push",
    description:
      "Stage all changes in the wiki repo, commit with the given message, and push to origin. Call this once, after all edits (including your changelog entry) are done.",
    parameters: Type.Object({
      message: Type.String({ description: "Commit message describing what changed and why." }),
    }),
    execute: async (_toolCallId, params) => {
      // Deterministic check, not a prompted "double check your relative links" instruction --
      // there's no human review before this pushes, so a model that forgets (or checks the
      // wrong path) would otherwise ship a dead link straight to the wiki. Blocks the commit
      // outright rather than warning, since the model can still fix it in the same turn.
      // Fails closed: if the checker itself can't run (e.g. lychee missing from the image),
      // that's treated the same as finding broken links rather than silently skipping the gate.
      try {
        const broken = await findBrokenLinks(opts.repo.dir);
        if (broken.length > 0) {
          const list = broken.map((b) => `- ${b.file}: [${b.target}] -- ${b.reason}`).join("\n");
          return {
            content: [{ type: "text" as const, text: `Commit blocked: broken link(s):\n${list}` }],
            details: { sha: null },
            isError: true,
          };
        }
      } catch (err) {
        // Unlike broken links themselves (a wiki-content problem the model can fix and retry),
        // the checker failing to run at all is an infra problem -- e.g. lychee missing from the
        // image. Treated the same as a push failure so the session throws and sweep.ts leaves
        // the watermark untouched, retrying this batch once the checker works again, rather than
        // silently skipping it.
        commitError = err instanceof Error ? err : new Error(String(err));
        logger.error({ guildId: opts.guildId, runId: opts.runId, err: commitError }, "link check failed to run");
        return {
          content: [{ type: "text" as const, text: `Commit blocked: link check failed to run: ${commitError.message}` }],
          details: { sha: null },
          isError: true,
        };
      }

      // Appended in code, not asked of the model -- guarantees every commit is traceable to the
      // session that produced it (Grafana logs/traces, and the on-disk transcript on the host)
      // regardless of whether the model remembers to include it or formats it consistently.
      const message = `${params.message as string}\n\nSync-run: ${opts.runId}`;
      try {
        commitSha = await commitAndPush(opts.repo, message);
      } catch (err) {
        commitError = err instanceof Error ? err : new Error(String(err));
        return {
          content: [{ type: "text" as const, text: `Commit/push failed: ${commitError.message}` }],
          details: { sha: null },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: commitSha ? `Committed and pushed as ${commitSha}` : "Nothing to commit — working tree was clean.",
          },
        ],
        details: { sha: commitSha },
      };
    },
  });

  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.wikiSync.agentDir, "auth.json"),
    modelsPath: join(config.wikiSync.agentDir, "models.json"),
  });

  // Registered directly on the runtime (not via an extension factory): extensions loaded
  // through a resourceLoader only get bound to a live modelRuntime as part of session
  // creation, which happens after createAgentSession() has already resolved its initial
  // model — registering here first avoids that ordering trap entirely.
  //
  // samplingParams carries OpenRouter's data_collection: "deny" on every request — Discord's
  // ToS requires opting message content out of model training, and Pi's typed provider config
  // has no dedicated field for it (verified against pi-ai's request builder), but samplingParams
  // is merged into the request body as-is for openai-completions providers.
  // sendSessionAffinityHeaders opts into pi-ai's session-affinity support (off by default): it
  // sends the AgentSession's own sessionId as `x-session-id` on every request, auto-detected as
  // the OpenRouter header format from baseUrl. That's what shows up as the request's session in
  // OpenRouter's dashboard/activity view -- no manual id plumbing needed here.
  // Independent of the main agent's model: wiki-sync only ever edits text files, never
  // images, so it can run a cheaper text-only model instead of reusing openaiModel.
  const contextWindow = await resolveContextWindow(config.wikiSync.model);
  // Capped against the resolved contextWindow, not used as-is -- config.wikiSync.maxOutputTokens
  // is a per-turn output budget we control, not the model's own max_completion_tokens (which
  // OpenRouter reports as equal to its context window for this model; sending that directly as
  // max_tokens is what made every prompt + max_tokens combination overflow the real ceiling).
  const maxTokens = Math.min(config.wikiSync.maxOutputTokens, contextWindow);
  modelRuntime.registerProvider(PROVIDER_ID, {
    name: "sushii OpenRouter",
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    api: "openai-completions",
    models: [
      {
        id: config.wikiSync.model,
        name: config.wikiSync.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
        samplingParams: { provider: { data_collection: "deny" } },
        compat: { sendSessionAffinityHeaders: true },
      },
    ],
  });

  const model = modelRuntime.getModel(PROVIDER_ID, config.wikiSync.model);
  if (!model) throw new Error(`wiki-sync model ${PROVIDER_ID}/${config.wikiSync.model} failed to register`);

  // AGENTS.md at the wiki repo's root, if the maintainer added one, is picked up automatically
  // here — DefaultResourceLoader walks up from cwd (the repo checkout) discovering context
  // files, letting wiki maintainers tune tone/scope/conventions by editing their own repo, no
  // sushii-agent redeploy needed. It doesn't compete with systemPromptOverride below; Pi injects
  // discovered context files as their own section alongside the custom system prompt.
  //
  // The walk itself doesn't stop at the repo boundary (verified against Pi's own source) — it
  // continues up the real filesystem to /, so without this filter an AGENTS.md placed anywhere
  // above the clone (e.g. accidentally added to this app's own image) would silently join the
  // context too. Filtering to paths under the repo keeps only what the wiki maintainer controls.
  const repoRoot = resolve(opts.repo.dir);
  const loader = new DefaultResourceLoader({
    cwd: opts.repo.dir,
    agentDir: config.wikiSync.agentDir,
    systemPromptOverride: () => WIKI_SYNC_SYSTEM_PROMPT,
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((f) => resolve(f.path) === repoRoot || resolve(f.path).startsWith(repoRoot + sep)),
    }),
  });
  await loader.reload();

  // In-memory only (no settings.json written) -- pi's compaction defaults to a 16384-token
  // reserve, sized for a normal reply. maxOutputTokens now lets a single turn emit up to the
  // model's real ceiling, so the reserve has to scale with it: otherwise compaction's own
  // "is there room left" check can pass right before a turn tries to use its full output
  // budget, blows past contextWindow, and the request fails outright instead of ever getting
  // proactively compacted.
  const settingsManager = SettingsManager.inMemory({
    compaction: { reserveTokens: config.wikiSync.maxOutputTokens },
  });

  const { session } = await createAgentSession({
    cwd: opts.repo.dir,
    agentDir: config.wikiSync.agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    tools: ["read", "edit", "write", "grep", "find", "ls", "commit_and_push"],
    excludeTools: ["bash", "ask_question"],
    customTools: [commitAndPushTool],
    sessionManager: SessionManager.create(opts.repo.dir, join(config.wikiSync.agentDir, "sessions")),
  });

  const eventLog = sessionLogger.child({ guildId: opts.guildId });
  const spans = createSessionSpans();
  let finalText = "";
  // Reset before each session.prompt() call below (initial + continue-nudge retries) so a prior
  // attempt's activity doesn't mask the next attempt coming back empty too.
  let turnHadActivity = false;
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta ?? "";
    }
    if (
      event.type === "tool_execution_start" ||
      (event.type === "message_update" &&
        (event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "thinking_delta"))
    ) {
      turnHadActivity = true;
    }
    logSessionEvent(eventLog, event);
    spans.handle(event);
  });

  try {
    await session.prompt(opts.prompt);

    // pi-coding-agent's own auto_retry only covers transient provider errors (rate limits,
    // overloads) -- a completion that stops with literally nothing (no text, no thinking, no
    // tool call) isn't an error from its point of view, so it ends the session as if the turn
    // were legitimately finished. Left alone this looks identical to "nothing needed syncing"
    // and sweep.ts advances its watermark past messages that were never actually looked at.
    for (let attempt = 0; attempt < MAX_EMPTY_TURN_RETRIES && !turnHadActivity && !commitError; attempt++) {
      logger.warn({ guildId: opts.guildId, runId: opts.runId, attempt: attempt + 1 }, "empty turn from provider, nudging session to continue");
      turnHadActivity = false;
      await session.prompt(CONTINUE_NUDGE_PROMPT);
    }
  } finally {
    spans.endAll();
  }
  session.dispose();

  logger.info({ guildId: opts.guildId, commitSha, finalText: finalText.slice(0, 2000), hadActivity: turnHadActivity }, "session finished");

  // Surface a failed push as a thrown error rather than a successful-looking result — tool
  // execution errors are reported back to the model as a turn result, not rethrown out of
  // session.prompt(), so without this a failed push would look identical to "sweep succeeded,
  // nothing to commit" and the caller would advance its watermark past messages that were
  // never actually synced.
  if (commitError) throw commitError;

  // Still empty after every nudge -- treat like the commit-error path above: throw instead of
  // returning a quiet no-op, so sweep.ts's watermark stays put and this batch is retried on the
  // next sweep rather than silently marked processed.
  if (!turnHadActivity) {
    throw new Error(`wiki-sync session for guild ${opts.guildId} produced no output after ${MAX_EMPTY_TURN_RETRIES} continue-nudges`);
  }

  return { finalText, commitSha };
}
