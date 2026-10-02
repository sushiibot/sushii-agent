import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOpenRouterCatalog } from "../agentRuntime/piShared.ts";
import { BackendSelector } from "./chatgptFallback.ts";
import type { WorkspaceConfig } from "./config.ts";
import { runToolFreeJob } from "./jobSession.ts";
import { RunLog } from "./runLog.ts";

const realFetch = globalThis.fetch;
let root: string | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearOpenRouterCatalog();
  if (root) rmSync(root, { recursive: true, force: true });
});

function sse(delta: object, inputTokens = 10, tool = false) {
  const chunk = (d: object, finish: string | null, extra = {}) =>
    `data: ${JSON.stringify({ id: "gen", object: "chat.completion.chunk", created: 1, model: "test/job", choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra })}\n\n`;
  return new Response(
    chunk(delta, null) +
      chunk({}, tool ? "tool_calls" : "stop", {
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: 3,
          total_tokens: inputTokens + 3,
        },
      }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

for (const mode of ["threshold", "overflow"] as const) {
  test(`a real job session compacts on ${mode} and continues to a settled reply despite disabled disk settings`, async () => {
    root = mkdtempSync(join(tmpdir(), "sushii-job-compact-"));
    const config = {
      provider: "openrouter",
      model: "test/job",
      chatgptModel: "gpt-6.1-sol",
      apiKey: "test",
      baseUrl: "http://job.test/v1",
      home: join(root, "home"),
      agentDir: join(root, "agent"),
      stateDir: join(root, "state"),
    } as WorkspaceConfig;
    for (const dir of [config.home, config.agentDir, config.stateDir])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(config.agentDir, "settings.json"),
      JSON.stringify({ compaction: { enabled: false } }),
    );
    writeFileSync(
      join(config.home, "notes.txt"),
      "historical details ".repeat(1200),
    );
    clearOpenRouterCatalog();
    let calls = 0;
    let summaries = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/models"))
        return Response.json({
          data: [{ id: "test/job", context_length: 8000 }],
        });
      const body = JSON.parse(String(init?.body));
      const summary =
        JSON.stringify(body.messages).includes("summarization") ||
        JSON.stringify(body.messages).includes("context checkpoint summary");
      if (summary) {
        summaries++;
        return sse({
          role: "assistant",
          content: "Summary of historical details.",
        });
      }
      calls++;
      if (calls === 1)
        return sse(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-read",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "notes.txt" }),
                },
              },
            ],
          },
          mode === "threshold" ? 6500 : 10,
          true,
        );
      if (calls === 2 && mode === "overflow")
        return Response.json(
          {
            error: {
              message: "maximum context length exceeded",
              code: "context_length_exceeded",
            },
          },
          { status: 400 },
        );
      return sse({
        role: "assistant",
        content: "Job finished after compaction.",
      });
    }) as typeof fetch;
    const result = await runToolFreeJob(config, {
      agentName: "job:compact",
      systemPrompt: "Read notes.txt, then finish.",
      prompt: "Read the notes and finish the job.",
      readOnlyTools: {},
      runs: new RunLog(config.stateDir),
      selector: new BackendSelector({ primaryEnabled: false }),
      timeoutMs: 5000,
    });
    expect(result.text).toBe("Job finished after compaction.");
    const entries = readFileSync(result.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.some((e) => e.type === "compaction")).toBe(true);
    expect(summaries).toBeGreaterThan(0);
  });
}
