import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS } from "../orchestration/contracts.ts";
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

  test("models/get lists the choice; models/set switches like !model and refuses an unknown alias", async () => {
    const { d, config } = deps();
    const h = commandHandlers(d);
    const list = [
      { alias: "sol", backend: "chatgpt", id: "gpt-6.1-sol" },
      { alias: "luna", backend: "chatgpt", id: "gpt-6-luna" },
      { alias: "or-luna", backend: "openrouter", id: "openai/gpt-6-luna" },
    ];
    expect(await h[RPC_METHODS.modelsGet]!({ principalId: "drk" })).toEqual({ current: "sol", models: list });
    expect(await h[RPC_METHODS.modelsSet]!({ principalId: "drk", alias: "or-luna" })).toEqual({ current: "or-luna", models: list });
    expect(config.provider).toBe("openrouter");
    await expect(h[RPC_METHODS.modelsSet]!({ principalId: "drk", alias: "gpt-9" })).rejects.toThrow('unknown model "gpt-9"');
    await expect(h[RPC_METHODS.modelsGet]!({ principalId: "mallory" })).rejects.toThrow("principal mismatch");
  });
});
