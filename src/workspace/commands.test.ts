import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS, UNKNOWN_MODEL_CODE, type ModelsResult, type ModelsSearchResult } from "../orchestration/contracts.ts";
import type { CatalogModel } from "../agentRuntime/piShared.ts";
import { commandHandlers, runCommand, type CommandDeps } from "./commands.ts";
import { parseModelList, type WorkspaceConfig } from "./config.ts";
import { ModelChoice } from "./modelChoice.ts";
import { statePath } from "./state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps(over: Partial<CommandDeps> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ws-cmd-"));
  dirs.push(stateDir);
  const config = { provider: "chatgpt", chatgptModel: "gpt-6.1-sol", model: "openai/gpt-6-luna", models: parseModelList("sol=chatgpt:gpt-6.1-sol,luna=chatgpt:gpt-6-luna,or-luna=openrouter:openai/gpt-6-luna") } as WorkspaceConfig;
  const d: CommandDeps = {
    principalId: "drk",
    compact: async () => ({ tokensBefore: 152_300, tokensAfter: 41_200 }),
    choice: new ModelChoice(config, stateDir),
    currentModel: () => "chatgpt/gpt-6.1-sol",
    tasks: (arg) => (arg ? `project ${arg}` : "index"),
    ...over,
  };
  return { d, config, stateDir };
}

describe("workspace commands", () => {
  test("models/get forwards the validated conversation scope and remains compatible without costs", async () => {
    const cost = { today: { usd: 0.2, recordedRuns: 1, unpricedRuns: 0 }, date: "2026-10-01", timeZone: "UTC" };
    const scopes: (string | undefined)[] = [];
    const { d } = deps({ catalog: async () => [], costs: async scope => { scopes.push(scope); return cost; } });
    const get = commandHandlers(d)[RPC_METHODS.modelsGet]!;
    expect(await get({ principalId: "drk", conversationId: "ux" })).toMatchObject({ cost });
    expect(await get({ principalId: "drk" })).toMatchObject({ cost });
    expect(scopes).toEqual(["ux", undefined]);
    await expect(get({ principalId: "drk", conversationId: "../bad" })).rejects.toThrow();
    await expect(get({ principalId: "mallory" })).rejects.toThrow("principal mismatch");
    expect(scopes).toHaveLength(2);
    expect(await commandHandlers(deps({ catalog: async () => [] }).d)[RPC_METHODS.modelsGet]!({ principalId: "drk" })).not.toHaveProperty("cost");
  });
  test("!compact reports tokens before and after, or why it didn't", async () => {
    const { d } = deps();
    expect(await runCommand({ principalId: "drk", command: "compact" }, d)).toEqual({ text: "🗜️ Compacted: 152,300 → ~41,200 tokens." });
    const failing = deps({ compact: async () => ({ error: "Nothing to compact (session too small)" }) }).d;
    expect(await runCommand({ principalId: "drk", command: "compact" }, failing)).toEqual({ text: "Didn't compact: Nothing to compact (session too small)" });
  });

  test("!model lists; !model <alias> switches, persists and says when it applies", async () => {
    const { d, config, stateDir } = deps();
    const list = (await runCommand({ principalId: "drk", command: "model" }, d)).text;
    expect(list).toContain("Model: **sol**");
    expect(list).toContain("Last answer came from chatgpt/gpt-6.1-sol.");
    expect(list).toContain("`or-luna`");
    expect((await runCommand({ principalId: "drk", command: "model", args: "or-luna" }, d)).text).toBe("Model set to **or-luna**: OpenRouter `openai/gpt-6-luna`, from the next turn.");
    expect(config.provider).toBe("openrouter");
    expect(JSON.parse(readFileSync(statePath(stateDir), "utf8"))).toEqual({ modelAlias: "or-luna" });
    expect((await runCommand({ principalId: "drk", command: "model", args: "or-luna" }, d)).text).toStartWith("Already on **or-luna**");
    expect((await runCommand({ principalId: "drk", command: "model", args: "luna" }, d)).text).toBe(
      "Model set to **luna**: ChatGPT `gpt-6-luna` (OpenRouter while ChatGPT is unavailable), from the next turn.",
    );
    expect((await runCommand({ principalId: "drk", command: "model", args: "gpt-9" }, d)).text).toContain('unknown model "gpt-9"');
  });

  test("!tasks passes its argument through; the RPC handler checks the principal", async () => {
    const { d } = deps();
    const handler = commandHandlers(d)[RPC_METHODS.chatCommand]!;
    expect(await handler({ principalId: "drk", command: "tasks" })).toEqual({ text: "index" });
    expect(await handler({ principalId: "drk", command: "tasks", args: "osaka" })).toEqual({ text: "project osaka" });
    await expect(handler({ principalId: "mallory", command: "tasks" })).rejects.toThrow("principal mismatch");
    await expect(handler({ principalId: "drk", command: "rm -rf" })).rejects.toThrow();
  });

  test("models/get lists the choice with catalog facts and the fallback; models/set switches either; unknown ids are refused", async () => {
    const catalog: CatalogModel[] = [
      { id: "openai/gpt-6.1-sol", name: "Sol", contextWindow: 1_050_000, image: true, tools: true, priceIn: 2, priceOut: 10 },
      { id: "openai/gpt-6-luna", name: "Luna", contextWindow: 1_050_000, image: true, tools: true, priceIn: 0.1, priceOut: 0.5 },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_048_576, image: false, tools: true, priceIn: 0.21, priceOut: 0.42 },
    ];
    const { d, config } = deps({ catalog: async () => catalog, fallbackUntil: () => Date.parse("2026-10-01T16:00:00Z") });
    const h = commandHandlers(d);
    const got = (await h[RPC_METHODS.modelsGet]!({ principalId: "drk" })) as ModelsResult;
    expect(got.current).toBe("sol");
    expect(got.models[0]).toEqual({ alias: "sol", backend: "chatgpt", id: "gpt-6.1-sol", contextWindow: 1_050_000 });
    expect(got.models[2]).toEqual({ alias: "or-luna", backend: "openrouter", id: "openai/gpt-6-luna", contextWindow: 1_050_000, priceIn: 0.1, priceOut: 0.5, image: true });
    expect(got.fallback).toBe("openai/gpt-6-luna");
    expect(got.fallbackUntil).toBe("2026-10-01T16:00:00.000Z");

    const custom = (await h[RPC_METHODS.modelsSet]!({ principalId: "drk", alias: "deepseek/deepseek-v4-pro" })) as ModelsResult;
    expect(custom.current).toBe("deepseek/deepseek-v4-pro");
    expect(custom.models.at(-1)).toMatchObject({ alias: "deepseek/deepseek-v4-pro", priceIn: 0.21 });
    expect(config.provider).toBe("openrouter");
    const fb = (await h[RPC_METHODS.modelsSet]!({ principalId: "drk", alias: "deepseek/deepseek-v4-pro", role: "fallback" })) as ModelsResult;
    expect(fb.fallback).toBe("deepseek/deepseek-v4-pro");
    await expect(h[RPC_METHODS.modelsSet]!({ principalId: "drk", alias: "gpt-9" })).rejects.toMatchObject({ code: UNKNOWN_MODEL_CODE, message: expect.stringContaining('unknown model "gpt-9"') });
    await expect(h[RPC_METHODS.modelsGet]!({ principalId: "mallory" })).rejects.toThrow("principal mismatch");
  });

  test("models/get still answers when the catalog can't be read", async () => {
    const { d } = deps({ catalog: () => Promise.reject(new Error("offline")) });
    const got = (await commandHandlers(d)[RPC_METHODS.modelsGet]!({ principalId: "drk" })) as ModelsResult;
    expect(got.models.map((m) => m.alias)).toEqual(["sol", "luna", "or-luna"]);
    expect(got.fallbackUntil).toBeNull();
  });

  test("models/search finds tool-capable models by every word, cheapest first, never batch variants", async () => {
    const m = (id: string, priceIn: number, tools = true, contextWindow = 200_000): CatalogModel => ({ id, name: id, contextWindow, image: false, tools, priceIn, priceOut: priceIn });
    const { d } = deps({
      catalog: async () => [m("qwen/qwen3.7-plus", 0.32), m("qwen/qwen3.7-flash", 0.03), m("qwen/qwen3.7-flash:batch", 0.01), m("qwen/qwen-chat-only", 0.01, false), m("qwen/qwen3.7-tiny", 0.001, true, 32_000), m("deepseek/v4", 0.2)],
    });
    const res = (await commandHandlers(d)[RPC_METHODS.modelsSearch]!({ principalId: "drk", query: "QWEN 3.7" })) as ModelsSearchResult;
    expect(res.models.map((x) => x.id)).toEqual(["qwen/qwen3.7-flash", "qwen/qwen3.7-plus"]);
  });
});
