import { join } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readJson } from "./files.ts";
import { runsGet, runsList, type RunsRpcOptions } from "./runsRpc.ts";
import { runLogPath } from "./runLog.ts";
import { TOPIC_ID_RE } from "../orchestration/contracts.ts";
import {
  safeText,
  scanRunIndexSync,
  toRunSummary,
  runConversationOf,
} from "./runReader.ts";

export function threadIndex(stateDir: string) {
  const catalog =
    readJson<Record<string, { title?: unknown; archived?: unknown }>>(
      join(stateDir, "topics.json"),
    ) ?? {};
  // Scan bounded metadata only. No transcript is opened by index/awareness.
  const index = scanRunIndexSync(runLogPath(stateDir));
  const activity = new Map<string, string>();
  for (const record of index.runs.values()) {
    const summary = toRunSummary(record);
    if (!summary) continue;
    const parent = record.parentRunId
      ? index.runs.get(record.parentRunId)
      : undefined;
    const conversation =
      runConversationOf(record) ??
      (parent ? runConversationOf(parent) : undefined);
    if (!conversation) continue;
    const at = summary.endedAt ?? summary.startedAt;
    if (
      !activity.has(conversation) ||
      Date.parse(at) > Date.parse(activity.get(conversation)!)
    )
      activity.set(conversation, at);
  }
  return Object.entries(catalog)
    .filter(
      ([id, r]) =>
        id !== "main" &&
        TOPIC_ID_RE.test(id) &&
        r &&
        typeof r.title === "string",
    )
    .map(([id, r]) => ({
      id,
      title: safeText(r.title as string, 120, { oneLine: true }),
      archived: r.archived === true,
      lastActivity: activity.get(id) ?? null,
      href: `/chats/${id}`,
    }));
}

/** Only thread metadata enters the prompt. Conversation contents require an explicit tool call. */
export function threadAwareness(stateDir: string): ExtensionFactory {
  return (pi) => {
    // Snapshot once per user turn so tool calls and cached continuations use
    // exactly the same prompt. Metadata is ephemeral, never a user message.
    let metadata = "";
    pi.on("before_agent_start", () => {
      const index = threadIndex(stateDir);
      metadata = index.length
        ? `Main is a general-purpose hub. Threads are persistent topic conversations, not delegated tasks. They do not report back on archive. Use list_threads to discover topics and get_thread_history only when relevant; do not retrieve every thread by default. Shared workspace memory is separate from conversation history.\nThread index (metadata only): ${JSON.stringify(index)}`
        : "";
    });
    pi.on("context_with_system", ({ messages }) => {
      if (!metadata || messages[0]?.role !== "system") return;
      const [system, ...rest] = messages;
      return {
        messages: [
          { ...system, sections: { ...system.sections, threadIndex: metadata } },
          ...rest,
        ],
      };
    });
  };
}

export function threadContextTools(opts: RunsRpcOptions): ToolDefinition[] {
  return [
    {
      name: "list_threads",
      label: "List topic threads",
      description:
        "List persistent topic threads, including archived ones. Returns metadata only, never conversation history.",
      parameters: Type.Object({}),
      execute: async () => ({
        details: {},
        content: [
          { type: "text", text: JSON.stringify(threadIndex(opts.stateDir)) },
        ],
      }),
    },
    {
      name: "get_thread_history",
      label: "Read thread history",
      description:
        "Retrieve a selected topic's recent conversation or existing run summaries on demand. Thread IDs come from list_threads. Use before to retrieve older runs. Archived threads remain readable. Does not resume or message the thread.",
      parameters: Type.Object({
        id: Type.String(),
        summariesOnly: Type.Optional(Type.Boolean()),
        before: Type.Optional(Type.String()),
      }),
      execute: async (_callId, raw) => {
        const args = z
          .object({
            id: z.string(),
            summariesOnly: z.boolean().optional(),
            before: z.string().optional(),
          })
          .strict()
          .parse(raw);
        if (!threadIndex(opts.stateDir).some((t) => t.id === args.id))
          throw new Error("Unknown thread");
        const page = await runsList(opts, {
          principalId: opts.principalId,
          conversationId: args.id,
          kinds: ["chat"],
          limit: 8,
          ...(args.before ? { before: args.before } : {}),
        });
        const history = [];
        for (const run of page.runs) {
          if (args.summariesOnly)
            history.push({
              runId: run.runId,
              at: run.startedAt,
              summary: run.resultSummary ?? run.title,
            });
          else {
            const detail = await runsGet(opts, {
              principalId: opts.principalId,
              runId: run.runId,
              limit: 100,
            });
            history.push({
              runId: run.runId,
              at: run.startedAt,
              steps: detail.found
                ? detail.steps.filter(
                    (s) => s.type === "user" || s.type === "assistant",
                  )
                : [],
              truncated: detail.found && !!detail.after,
              session: detail.found ? detail.session : "missing",
            });
          }
        }
        return {
          details: {},
          content: [
            {
              type: "text",
              text: JSON.stringify({
                threadId: args.id,
                href: `/chats/${args.id}`,
                history: history.reverse(),
                before: page.before,
                truncated: page.truncated,
              }),
            },
          ],
        };
      },
    },
  ];
}
