import { describe, expect, test } from "bun:test";
import { renderRunnerSection } from "./capabilityPrompt.ts";

describe("renderRunnerSection", () => {
  test("lists online runners with their capabilities and tells the model to dispatch browser work", () => {
    const text = renderRunnerSection([
      { runnerId: "cloud", kind: "pi", location: "apps · container", workspaceRoot: "/data/workspace", capabilities: ["browser"], projects: [] },
      { runnerId: "desktop", kind: "claude-code", location: null, workspaceRoot: null, capabilities: [], projects: ["/home/d/sushii-agent"] },
    ]);
    expect(text).toContain("- cloud (pi, apps · container): browser; clones repos, scratch tasks");
    expect(text).toContain("- desktop (claude-code): projects: sushii-agent");
    expect(text).toContain("Never tell the user you can't browse");
    expect(text).toContain("browser=true");
  });

  test("tells a non-owner that dispatches need confirmation", () => {
    expect(renderRunnerSection([], { needsConfirmation: true })).toContain("Your dispatches need confirmation");
    expect(renderRunnerSection([])).not.toContain("need confirmation");
  });

  test("says so when no runner is online", () => {
    expect(renderRunnerSection([])).toContain("No runners are online right now");
  });
});
