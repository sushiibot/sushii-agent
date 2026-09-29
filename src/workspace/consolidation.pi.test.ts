import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "./config.ts";
import { CONSOLIDATION_AGENT, MARKERS, SYSTEM_PROMPT, createConsolidationJob } from "./consolidation.ts";
import { commitHome, scaffoldHome } from "./home.ts";
import { runToolFreeJob } from "./jobSession.ts";
import { RunLog } from "./runLog.ts";
import { jobSessionDir } from "./sessionPaths.ts";

// Real Pi 0.99.1 job sessions; the only fake is fetch.
const OPENROUTER_BASE = "http://openrouter.test/v1";
const OPENROUTER_MODEL = "openai/gpt-6-luna";
const USAGE_LIMIT_BODY = { error: { code: "subscription_sharing_usage_limit_exceeded", type: "usage_limit_reached", message: "usage limit reached" } };
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const AGENTS_MARKER = "AGENTS-MD-MUST-NOT-REACH-THE-JOB";

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

let root: string;
let requests: string[];
let bodies: Body[];
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
const savedEnv: Record<string, string | undefined> = {};

const isChatGpt = (url: string) => url.startsWith("https://api.openai.com/");
const isOpenRouter = (url: string) => url.startsWith(`${OPENROUTER_BASE}/chat/completions`);

function stubFetch(handler: (url: string) => Response | undefined): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (isOpenRouter(url)) bodies.push(JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}"))));
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return new Response("", { status: 503 });
    const response = handler(url);
    if (!response) throw new Error(`unexpected fetch in test: ${url}`);
    return response;
  }) as unknown as typeof fetch;
}

function openRouterReply(text: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: OPENROUTER_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const body = chunk({ role: "assistant", content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function signInChatGpt(): void {
  writeFileSync(
    join(root, "agent", "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 24 * 3_600_000, clientId: "c", scopes: ["chatgpt.tokens.use.direct"] },
    }),
  );
}

function config(provider: "chatgpt" | "openrouter" = "chatgpt"): WorkspaceConfig {
  return {
    provider,
    chatgptModel: "gpt-6.1-sol",
    model: OPENROUTER_MODEL,
    apiKey: "test-openrouter-key",
    baseUrl: OPENROUTER_BASE,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    stateDir: join(root, "state"),
    tz: "UTC",
    consolidateAt: "04:00",
  } as WorkspaceConfig;
}

const USER = "# USER.md\n\n- Prefers metric units. (src: 2026-09-01, discord:111)\n";
const MEMORY = "# MEMORY.md\n\n- Deploys on push to main. (src: 2026-09-02, discord:222)\n- Deploys from main via CI. (src: 2026-09-10, discord:333)\n";
const NEW_MEMORY = "# MEMORY.md\n\n- Deploys from main via CI on every push. (src: 2026-09-10, discord:333)\n- Uses uv for Python. (src: 2026-09-28)\n";
const PROPOSAL = [MARKERS.userBegin, USER, MARKERS.userEnd, MARKERS.memoryBegin, NEW_MEMORY, MARKERS.memoryEnd, MARKERS.summaryBegin, "merged: deploy entries", MARKERS.summaryEnd].join("\n");

beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const k of Object.keys(GIT_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ws-consolidate-pi-"));
  requests = [];
  bodies = [];
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(root, "agent"), { recursive: true });
  const home = join(root, "home");
  await scaffoldHome(home);
  writeFileSync(join(home, "AGENTS.md"), `# AGENTS\n${AGENTS_MARKER}\n`);
  writeFileSync(join(home, "USER.md"), USER);
  writeFileSync(join(home, "MEMORY.md"), MEMORY);
  writeFileSync(join(home, "memory", "2026-09-28.md"), `- Started using uv for Python.\n${"- worked on the workspace\n".repeat(100)}`);
  await commitHome("seed", { home });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  rmSync(root, { recursive: true, force: true });
});

describe("consolidation job on a real Pi session", () => {
  test("ChatGPT limit → OpenRouter retry; no tools on the wire; applied; logged as job:consolidation", async () => {
    signInChatGpt();
    stubFetch((url) => (isChatGpt(url) ? jsonResponse(429, USAGE_LIMIT_BODY) : isOpenRouter(url) ? openRouterReply(PROPOSAL) : undefined));
    const runs = new RunLog(config().stateDir);

    const outcome = await createConsolidationJob(config(), { runs }).run({ trigger: "manual", force: false });

    expect(outcome.status).toBe("applied");
    expect(requests.filter(isChatGpt)).toHaveLength(1);
    expect(requests.filter(isOpenRouter)).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.tools ?? []).toEqual([]);
    const system = JSON.stringify(body.messages.filter((m) => m.role === "system"));
    expect(system).toContain(SYSTEM_PROMPT.slice(0, 60));
    expect(JSON.stringify(body)).not.toContain(AGENTS_MARKER);
    expect(JSON.stringify(body.messages.at(-1))).toContain("<daily-note file=\\\"memory/2026-09-28.md\\\"");

    expect(readFileSync(join(root, "home", "MEMORY.md"), "utf8")).toBe(NEW_MEMORY);
    expect(readFileSync(join(root, "home", "DREAMS.md"), "utf8")).toContain(`- Model: ${OPENROUTER_MODEL}`);

    const [run] = runs.listRuns({ agentName: CONSOLIDATION_AGENT });
    expect(run).toMatchObject({ agentName: "job:consolidation", status: "done" });
    expect(run!.task).toContain("Consolidate drk's memory files.");
    expect(run!.sessionFile.startsWith(`${jobSessionDir(config().agentDir)}/`)).toBe(true);
    expect(existsSync(run!.sessionFile)).toBe(true);
  });

  test("the job session registers no tools, even with the OpenRouter-only backend", async () => {
    stubFetch((url) => (isOpenRouter(url) ? openRouterReply("done") : undefined));
    const runs = new RunLog(config("openrouter").stateDir);
    const result = await runToolFreeJob(config("openrouter"), { agentName: "job:test", systemPrompt: "Reply done.", prompt: "go", runs });
    expect(result).toMatchObject({ text: "done", model: OPENROUTER_MODEL });
    expect(bodies[0]!.tools ?? []).toEqual([]);
    // Pi appends only a <cwd> block to the override; none of its coding-agent prompt or tool docs.
    const system = bodies[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(String(system.content).startsWith("Reply done.\n")).toBe(true);
    expect(String(system.content)).not.toMatch(/bash|Available tools/i);
  });

  test("a model error fails the job, records a failed run, and leaves memory alone", async () => {
    stubFetch((url) => (isOpenRouter(url) ? jsonResponse(400, { error: { message: "bad request", code: 400 } }) : undefined));
    const runs = new RunLog(config("openrouter").stateDir);
    await expect(createConsolidationJob(config("openrouter"), { runs }).run({ trigger: "daily", force: false })).rejects.toThrow(/job reply error/);
    expect(runs.listRuns({ agentName: CONSOLIDATION_AGENT })[0]).toMatchObject({ status: "failed" });
    expect(readFileSync(join(root, "home", "MEMORY.md"), "utf8")).toBe(MEMORY);
  });
});
