// Golden/characterization tests for the current Components V2 packing logic.
// Imports the pre-cutover location on purpose: the surface-neutral migration will
// repoint this import, but these expected values must stay byte-identical.
import { describe, expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
import { buildComponentMessages, parseElements } from "../../../agent/delivery.ts";

// TEXT_DISPLAY_MAX (4000) and MAX_COMPONENTS (40) from delivery.ts, pinned via
// boundary-crossing inputs below rather than imported (they aren't exported).

function textContents(container: ContainerBuilder): string[] {
  const json = container.toJSON() as { components: { type: number; content?: string }[] };
  return json.components.filter((c) => c.type === 10).map((c) => c.content!);
}

function componentTypes(container: ContainerBuilder): number[] {
  const json = container.toJSON() as { components: { type: number }[] };
  return json.components.map((c) => c.type);
}

describe("parseElements", () => {
  test("plain text with no separators is a single text element", () => {
    expect(parseElements("foo")).toEqual([{ kind: "text", content: "foo" }]);
  });

  test("a `---` separator splits into text/separator/text", () => {
    expect(parseElements("foo\n---\nbar")).toEqual([
      { kind: "text", content: "foo" },
      { kind: "separator" },
      { kind: "text", content: "bar" },
    ]);
  });

  test("leading and trailing `---` dividers are stripped", () => {
    expect(parseElements("---\nfoo\n---\n")).toEqual([{ kind: "text", content: "foo" }]);
  });
});

describe("buildComponentMessages", () => {
  test("a small input packs into a single message with one TextDisplay", () => {
    const msgs = buildComponentMessages("hello world");
    expect(msgs).toHaveLength(1);
    const container = msgs[0].components![0] as ContainerBuilder;
    expect(textContents(container)).toEqual(["hello world"]);
  });

  test("a `---` separator becomes a divider component between two text displays", () => {
    const msgs = buildComponentMessages("first section\n---\nsecond section");
    expect(msgs).toHaveLength(1);
    const container = msgs[0].components![0] as ContainerBuilder;
    expect(componentTypes(container)).toEqual([10, 14, 10]);
    expect(textContents(container)).toEqual(["first section", "second section"]);
  });

  test("crossing the 4000-char total limit flushes into a new message, dropping the boundary separator but no text", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(1500);
    const msgs = buildComponentMessages(`${a}\n---\n${b}`);

    expect(msgs).toHaveLength(2);
    const container0 = msgs[0].components![0] as ContainerBuilder;
    const container1 = msgs[1].components![0] as ContainerBuilder;
    expect(textContents(container0)).toEqual([a]);
    expect(textContents(container1)).toEqual([b]);
    // No text content is dropped, even though the separator at the boundary is.
    expect(textContents(container0).concat(textContents(container1)).join("")).toBe(a + b);
  });

  test("crossing the 40-component limit flushes into a new message, dropping the boundary separator but no text", () => {
    const sections = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const msgs = buildComponentMessages(sections.join("\n---\n"));

    expect(msgs).toHaveLength(2);
    const container0 = msgs[0].components![0] as ContainerBuilder;
    const container1 = msgs[1].components![0] as ContainerBuilder;
    expect(componentTypes(container0)).toHaveLength(39);
    expect(componentTypes(container1)).toHaveLength(9);

    const allText = [...textContents(container0), ...textContents(container1)];
    expect(allText).toEqual(sections);
  });
});
