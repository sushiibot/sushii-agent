// Golden/characterization tests for the response footer format.
//
// Calls the REAL `buildFooter` (now exported from src/agent/loop.ts). The golden strings are the
// parity bar the cutover must reproduce from `TurnUsage` in the Discord surface. At cutover, repoint
// this import to the surface-neutral successor and keep the golden values fixed.
import { describe, expect, test } from "bun:test";
import { buildFooter } from "../../../agent/loop.ts";

describe("buildFooter golden values", () => {
  test("known pricing model, no cache, no tools", () => {
    const footer = buildFooter("anthropic/claude-sonnet-4", 15000, 500, 0, 0, 15000, 200000, []);
    expect(footer).toBe("-# anthropic/claude-sonnet-4 · 15,000 ctx (8%) · 500 out · $0.0525");
  });

  test("unknown pricing model shows no cost segment (cost-unknown case)", () => {
    const footer = buildFooter("mystery-model", 1000, 200, 100, 50, 1000, 100000, []);
    expect(footer).toBe("-# mystery-model · 1,000 ctx (1%) · 200 out · cache 100r 50w");
  });

  test("with cache activity, cache segment is included before cost", () => {
    const footer = buildFooter("anthropic/claude-opus-4", 20000, 1000, 5000, 2000, 20000, 200000, []);
    expect(footer).toBe(
      "-# anthropic/claude-opus-4 · 20,000 ctx (10%) · 1,000 out · cache 5,000r 2,000w · $0.3750",
    );
  });

  test("with used tools, each tool is appended as its own `-# -` line", () => {
    const footer = buildFooter(
      "anthropic/claude-haiku-4", 500, 100, 0, 0, 500, 100000,
      [{ name: "search", input: { query: "foo" } }],
    );
    expect(footer).toBe(
      '-# anthropic/claude-haiku-4 · 500 ctx (1%) · 100 out · $0.0008\n-# - search(query="foo")',
    );
  });

  test("a tool with no input args renders bare (no parens)", () => {
    const footer = buildFooter(
      "anthropic/claude-sonnet-4", 500, 100, 0, 0, 500, 100000,
      [{ name: "list_tools", input: {} }],
    );
    expect(footer).toBe(
      "-# anthropic/claude-sonnet-4 · 500 ctx (1%) · 100 out · $0.0030\n-# - list_tools",
    );
  });
});
