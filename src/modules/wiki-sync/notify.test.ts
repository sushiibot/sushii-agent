import { describe, expect, test } from "bun:test";
import { buildStatusContent, deriveWebUrl } from "./notify.ts";

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

  test("converts an https URL, stripping .git", () => {
    expect(deriveWebUrl("https://git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("strips embedded credentials from an https URL", () => {
    expect(deriveWebUrl("https://oauth2:secret-token@git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBe(
      "https://git.dreamcatcher.inc/dreamcatcher/wiki",
    );
  });

  test("returns null for an unsupported scheme", () => {
    expect(deriveWebUrl("git://git.dreamcatcher.inc/dreamcatcher/wiki.git")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(deriveWebUrl("")).toBeNull();
  });
});

describe("buildStatusContent", () => {
  test("returns just the commit line when there's no recap", () => {
    expect(buildStatusContent(null, "[View commit](https://example.com/commit/abc)")).toBe(
      "[View commit](https://example.com/commit/abc)",
    );
  });

  test("joins a short recap with the commit line unchanged", () => {
    const result = buildStatusContent("- someone shared a paper", "[View commit](https://example.com/commit/abc)");
    expect(result).toBe("- someone shared a paper\n\n[View commit](https://example.com/commit/abc)");
  });

  test("truncates a long recap but always preserves the commit link", () => {
    const commitLine = "[View commit](https://example.com/commit/abc)";
    const longRecap = "x".repeat(5000);

    const result = buildStatusContent(longRecap, commitLine);

    expect(result.endsWith(commitLine)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(3800);
  });

  test("truncated recap ends with an ellipsis before the commit link", () => {
    const commitLine = "[View commit](https://example.com/commit/abc)";
    const result = buildStatusContent("x".repeat(5000), commitLine);
    const recapPart = result.slice(0, result.indexOf("\n\n"));
    expect(recapPart.endsWith("…")).toBe(true);
  });
});
