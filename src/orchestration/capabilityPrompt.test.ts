import { describe, expect, test } from "bun:test";
import { buildCapabilitySections, renderCapabilityMap, renderRunnerSection } from "./capabilityPrompt.ts";

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

describe("capability sections follow the resolved tools", () => {
  const base = { surface: "slack", spaceId: "T1", userId: "U1", isPrivate: false, isOwner: false };

  test("the map lists only capabilities whose tools resolved", () => {
    const map = renderCapabilityMap(new Set(["web_search", "memory"]))!;
    expect(map).toContain("Search the web");
    expect(map).toContain("persist for this space");
    expect(map).not.toContain("knowledge base");
    expect(map).not.toContain("message history");
    expect(renderCapabilityMap(new Set())).toBeUndefined();
  });

  test("no dispatch tool means no runner section, even for the owner", () => {
    const text = buildCapabilitySections({ ...base, isOwner: true, tools: ["web_search"] }) ?? "";
    expect(text).not.toContain("## Runners");
  });
});
