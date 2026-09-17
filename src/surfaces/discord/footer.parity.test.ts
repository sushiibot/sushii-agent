// Parity tests: assert the NEW renderFooter reproduces the goldens pinned in
// characterization/footer.characterization.test.ts, from a TurnUsage instead of positional args.
import { describe, expect, test } from "bun:test";
import type { ToolActivity, TurnUsage } from "../../core/contracts.ts";
import { renderFooter } from "./footer.ts";

function usage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  contextTokens: number,
  contextLimit: number,
): TurnUsage {
  return { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, contextTokens, contextLimit };
}

describe("renderFooter golden parity", () => {
  test("known pricing model, no cache, no tools", () => {
    const footer = renderFooter(usage("anthropic/claude-sonnet-4", 15000, 500, 0, 0, 15000, 200000), []);
    expect(footer).toBe("-# anthropic/claude-sonnet-4 · 15,000 ctx (8%) · 500 out · $0.0525");
  });

  test("unknown pricing model shows no cost segment (cost-unknown case)", () => {
    const footer = renderFooter(usage("mystery-model", 1000, 200, 100, 50, 1000, 100000), []);
    expect(footer).toBe("-# mystery-model · 1,000 ctx (1%) · 200 out · cache 100r 50w");
  });

  test("with cache activity, cache segment is included before cost", () => {
    const footer = renderFooter(usage("anthropic/claude-opus-4", 20000, 1000, 5000, 2000, 20000, 200000), []);
    expect(footer).toBe(
      "-# anthropic/claude-opus-4 · 20,000 ctx (10%) · 1,000 out · cache 5,000r 2,000w · $0.3750",
    );
  });

  test("with used tools, each tool is appended as its own `-# -` line", () => {
    const tools: ToolActivity[] = [{ name: "search", input: { query: "foo" } }];
    const footer = renderFooter(usage("anthropic/claude-haiku-4", 500, 100, 0, 0, 500, 100000), tools);
    expect(footer).toBe(
      '-# anthropic/claude-haiku-4 · 500 ctx (1%) · 100 out · $0.0008\n-# - search(query="foo")',
    );
  });

  test("a tool with no input args renders bare (no parens)", () => {
    const tools: ToolActivity[] = [{ name: "list_tools", input: {} }];
    const footer = renderFooter(usage("anthropic/claude-sonnet-4", 500, 100, 0, 0, 500, 100000), tools);
    expect(footer).toBe("-# anthropic/claude-sonnet-4 · 500 ctx (1%) · 100 out · $0.0030\n-# - list_tools");
  });
});
