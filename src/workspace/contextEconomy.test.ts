import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MODELS_SPEC, WorkspaceConfigError, loadWorkspaceConfig, parseModelList, type WorkspaceConfig } from "./config.ts";
import { ANCHORED_SECTIONS, CLEARED_PREFIX, anchoredInstruction, createHygieneExtension, planHygiene, reserveTokensFor, type HygieneState } from "./contextEconomy.ts";
import { ModelChoice } from "./modelChoice.ts";
import { readWorkspaceState, writeWorkspaceState } from "./state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-economy-"));
  dirs.push(d);
  return d;
}

let n = 0;
const entry = (message: object): ProjectedSessionEntry => ({ sourceEntry: { type: "message", id: `e${++n}` } as never, messages: [message as never] });
const user = (text: string) => entry({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const call = (id: string, path: string) => entry({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] });
const result = (id: string, chars = 2000) => entry({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "x".repeat(chars) }], isError: false, timestamp: 0 });

/** `turns` user turns, each with `perTurn` read calls. */
function transcript(turns: number, perTurn: number, chars = 2000): ProjectedSessionEntry[] {
  const out: ProjectedSessionEntry[] = [];
  let c = 0;
  for (let t = 0; t < turns; t++) {
    out.push(user(`turn ${t}`));
    for (let i = 0; i < perTurn; i++) {
      const id = `c${++c}`;
      out.push(call(id, `notes/${id}.md`), result(id, chars));
    }
  }
  return out;
}

const resultIds = (entries: ProjectedSessionEntry[]) => entries.filter((e) => (e.messages[0] as { role: string }).role === "toolResult").map((e) => e.sourceEntry.id);

describe("planHygiene", () => {
  test("stubs results older than the last 8 and the last 3 user turns, naming the tool and args", () => {
    const entries = transcript(6, 3);
    const plan = planHygiene(entries);
    const ids = resultIds(entries);
    // 18 results; the last 3 turns hold the last 9, so the first 9 are cleared.
    expect(plan.drafts.map((d) => d.targetId)).toEqual(ids.slice(0, 9));
    expect(plan.clearedChars).toBe(9 * 2000);
    const stub = (plan.drafts[0]!.replacement!.content as Array<{ text: string }>)[0]!.text;
    expect(stub).toBe(`${CLEARED_PREFIX} read notes/c1.md, 2000 chars — rerun if needed]`);
  });

  test("the last 8 results stay even when they are older than the last 3 turns", () => {
    const entries = [...transcript(1, 10), user("a"), user("b"), user("c")];
    expect(planHygiene(entries).drafts.map((d) => d.targetId)).toEqual(resultIds(entries).slice(0, 2));
  });

  test("short results and already-cleared stubs are left alone", () => {
    const entries = transcript(6, 3, 200);
    expect(planHygiene(entries).drafts).toHaveLength(0);
    const cleared = transcript(6, 3);
    const first = cleared.find((e) => (e.messages[0] as { role: string }).role === "toolResult")!;
    (first.messages[0] as { content: unknown }).content = [{ type: "text", text: `${CLEARED_PREFIX} read x, 2000 chars — rerun if needed]${"y".repeat(700)}` }];
    expect(planHygiene(cleared).drafts.map((d) => d.targetId)).not.toContain(first.sourceEntry.id);
  });
});

describe("hygiene extension", () => {
  function harness(threshold: number) {
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    const state: HygieneState = { armed: true };
    const logs: string[] = [];
    createHygieneExtension({ thresholdTokens: threshold, state, log: { info: (_o, m) => logs.push(m), warn: (_o, m) => logs.push(m) } })({
      on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = h),
    } as never);
    const turnEnd = (tokens: number | null, entries: ProjectedSessionEntry[], prior: unknown[] = []) =>
      handlers.turn_end!({ entries: prior, context: { contextEntries: entries } }, { getContextUsage: () => ({ tokens }) }) as { entries: unknown[] } | undefined;
    return { handlers, state, logs, turnEnd };
  }

  test("listens only at turn boundaries", () => {
    expect(Object.keys(harness(100).handlers)).toEqual(["turn_end"]);
  });

  test("fires once per crossing of the threshold, keeping earlier drafts", () => {
    const h = harness(150_000);
    const entries = transcript(6, 3);
    expect(h.turnEnd(100_000, entries)).toBeUndefined();
    const prior = [{ type: "custom", customType: "x" }];
    const fired = h.turnEnd(160_000, entries, prior)!;
    expect(fired.entries[0]).toBe(prior[0]);
    expect(fired.entries).toHaveLength(1 + 9);
    // Still above: no second batch until the context drops below and crosses again.
    expect(h.turnEnd(170_000, transcript(7, 3))).toBeUndefined();
    expect(h.turnEnd(120_000, entries)).toBeUndefined();
    expect(h.turnEnd(155_000, transcript(7, 3))!.entries.length).toBeGreaterThan(0);
  });

  test("stays armed while nothing qualifies yet, and skips an unknown token count", () => {
    const h = harness(150_000);
    expect(h.turnEnd(null, transcript(6, 3))).toBeUndefined();
    expect(h.turnEnd(160_000, transcript(2, 3))).toBeUndefined();
    expect(h.state.armed).toBe(true);
    expect(h.turnEnd(160_000, transcript(6, 3))).toBeDefined();
    expect(h.state.armed).toBe(false);
  });
});

describe("compaction trigger", () => {
  test("reserve puts the trigger at the configured tokens, capped at 75% of the window", () => {
    expect(272_000 - reserveTokensFor(272_000, 200_000)).toBe(200_000);
    expect(800_000 - reserveTokensFor(800_000, 200_000)).toBe(200_000);
    expect(200_000 - reserveTokensFor(200_000, 200_000)).toBe(150_000);
    expect(128_000 - reserveTokensFor(128_000, 200_000)).toBe(96_000);
  });
});

describe("anchored instruction", () => {
  test("has the fixed sections and merges into the previous summary", () => {
    const first = anchoredInstruction("compaction");
    for (const s of ANCHORED_SECTIONS) expect(first).toContain(s);
    expect(first).not.toContain("<previous-summary>");
    expect(anchoredInstruction("recap", "## Goals\n- old goal")).toContain("<previous-summary>\n## Goals\n- old goal\n</previous-summary>");
  });
});

describe("model list and choice", () => {
  const base = (stateDir: string): WorkspaceConfig =>
    ({ provider: "chatgpt", chatgptModel: "gpt-6.1-sol", model: "openai/gpt-6-luna", models: parseModelList("sol=chatgpt:gpt-6.1-sol,luna=chatgpt:gpt-6-luna,or-mini=openrouter:test/mini"), stateDir }) as WorkspaceConfig;

  test("parses the list; rejects malformed and duplicate entries", () => {
    expect(parseModelList(DEFAULT_MODELS_SPEC)).toEqual([
      { alias: "sol", backend: "chatgpt", id: "gpt-6.1-sol" },
      { alias: "luna", backend: "chatgpt", id: "gpt-6-luna" },
    ]);
    expect(() => parseModelList("sol=gpt")).toThrow(WorkspaceConfigError);
    expect(() => parseModelList("a=chatgpt:x,a=openrouter:y")).toThrow(WorkspaceConfigError);
  });

  test("env defaults and overrides", () => {
    const env = { ORCH_SECRET: "s", OPENAI_API_KEY: "k", HOME: "/h" };
    const cfg = loadWorkspaceConfig(env);
    expect(cfg.economy).toEqual({ hygieneTokens: 150_000, compactTokens: 200_000, keepRecentTokens: 40_000, idleRotateMin: 25, idleRotateTokens: 100_000 });
    expect(cfg.models!.map((m) => m.alias)).toEqual(["sol", "luna"]);
    expect(cfg.tasks).toEqual({ staleDaysQuick: 2, autodropDaysQuick: 5, staleDaysProject: 7, autodropDaysProject: 21, maxOpen: 15 });
    const over = loadWorkspaceConfig({ ...env, WORKSPACE_HYGIENE_TOKENS: "90000", WORKSPACE_IDLE_ROTATE_MIN: "30", WORKSPACE_MODELS: "x=openrouter:a/b", WORKSPACE_TASK_MAX_OPEN: "20" });
    expect(over.economy!.hygieneTokens).toBe(90_000);
    expect(over.economy!.idleRotateMin).toBe(30);
    expect(over.models).toEqual([{ alias: "x", backend: "openrouter", id: "a/b" }]);
    expect(over.tasks!.maxOpen).toBe(20);
    expect(() => loadWorkspaceConfig({ ...env, WORKSPACE_COMPACT_TOKENS: "lots" })).toThrow(WorkspaceConfigError);
  });

  test("a chatgpt choice keeps the OpenRouter fallback; an openrouter choice pins it; the choice persists", () => {
    const stateDir = tempDir();
    writeWorkspaceState(stateDir, { chatSessionFile: "/s/chat.jsonl" });
    const cfg = base(stateDir);
    const choice = new ModelChoice(cfg, stateDir);
    expect(choice.current()?.alias).toBe("sol");
    expect(choice.openrouterIds()).toEqual(["openai/gpt-6-luna", "test/mini"]);

    expect(choice.select("LUNA")).toMatchObject({ ok: true, changed: true });
    expect(cfg).toMatchObject({ provider: "chatgpt", chatgptModel: "gpt-6-luna", model: "openai/gpt-6-luna" });
    expect(choice.select("or-mini")).toMatchObject({ ok: true });
    expect(cfg).toMatchObject({ provider: "openrouter", model: "test/mini" });
    expect(readWorkspaceState(stateDir)).toEqual({ chatSessionFile: "/s/chat.jsonl", modelAlias: "or-mini" });

    const restarted = base(stateDir);
    expect(new ModelChoice(restarted, stateDir).current()?.alias).toBe("or-mini");
    expect(restarted).toMatchObject({ provider: "openrouter", model: "test/mini" });

    expect(choice.select("gpt-7")).toEqual({ ok: false, error: 'unknown model "gpt-7"; choose one of sol, luna, or-mini' });
    expect(choice.select("sol")).toMatchObject({ ok: true });
    expect(cfg).toMatchObject({ provider: "chatgpt", chatgptModel: "gpt-6.1-sol", model: "openai/gpt-6-luna" });
    expect(choice.describe()).toContain("▸ `sol`");
  });

  test("state writes merge: a later session swap keeps the model choice", () => {
    const stateDir = tempDir();
    writeWorkspaceState(stateDir, { chatSessionFile: "/a", modelAlias: "luna" });
    writeWorkspaceState(stateDir, { chatSessionFile: "/b", recap: undefined });
    expect(readWorkspaceState(stateDir)).toEqual({ chatSessionFile: "/b", modelAlias: "luna" });
  });
});
