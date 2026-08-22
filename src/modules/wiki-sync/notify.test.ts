import { describe, expect, test } from "bun:test";
import { deriveWebUrl } from "./notify.ts";

describe("deriveWebUrl", () => {
  test("converts an ssh URL with a port to an https URL", () => {
    expect(deriveWebUrl("ssh://git@git.dreamcatcher.inc:2222/dreamcatcher/wiki.git")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("converts an ssh URL without a port", () => {
    expect(deriveWebUrl("ssh://git@github.com/sushiibot/wiki.git")).toBe("https://github.com/sushiibot/wiki");
  });

  test("handles a repo path without a .git suffix", () => {
    expect(deriveWebUrl("ssh://git@git.dreamcatcher.inc:2222/dreamcatcher/wiki")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("returns null for a non-ssh URL", () => {
    expect(deriveWebUrl("https://git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(deriveWebUrl("")).toBeNull();
  });
});
