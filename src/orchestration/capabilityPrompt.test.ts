import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { TeamConfig } from "./teams.ts";
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
  const base = { surface: "slack", spaceId: "T1", userId: "U1", isPrivate: false, isOwner: false, authorized: false };

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

describe("Team section", () => {
  const base = { surface: "slack", spaceId: "T1", userId: "U1", isPrivate: false, isOwner: false, authorized: false, tools: [] };
  const prevTeams = config.teams;

  beforeEach(() => {
    config.teams = {
      dreamcatcher: {
        spaces: [
          { surface: "discord", spaceId: "G1" },
          { surface: "slack", spaceId: "T1", wiki: "read" },
          { surface: "buzz", spaceId: "buzz:https://relay.example" },
        ],
        wiki: { wikiId: "G1" },
        members: { alice: { trusted: true }, bob: {} },
      } satisfies TeamConfig,
    };
  });
  afterEach(() => {
    config.teams = prevTeams;
  });

  test("absent when the space has no team", () => {
    const text = buildCapabilitySections({ ...base, spaceId: "T-not-a-team" }) ?? "";
    expect(text).not.toContain("## Team");
  });

  test("present with sibling space kinds and wiki note when the space belongs to a team", () => {
    const text = buildCapabilitySections(base) ?? "";
    expect(text).toContain("## Team");
    expect(text).toContain("dreamcatcher");
    expect(text).toContain("Discord guild");
    expect(text).toContain("Slack workspace");
    expect(text).toContain("buzz relay");
    expect(text).toContain("This space can read the team's shared wiki.");
  });

  test("no wiki line for a team space without wiki access", () => {
    const text = buildCapabilitySections({ ...base, surface: "buzz", spaceId: "buzz:https://relay.example" }) ?? "";
    expect(text).toContain("## Team");
    expect(text).not.toContain("wiki");
  });

  test("standing reflects owner / authorized / plain member, and never leaks member ids", () => {
    const owner = buildCapabilitySections({ ...base, isOwner: true, authorized: true }) ?? "";
    expect(owner).toContain("You are speaking with the owner of this team.");

    const trusted = buildCapabilitySections({ ...base, isOwner: false, authorized: true }) ?? "";
    expect(trusted).toContain("You are speaking with a trusted member of this team.");

    const plain = buildCapabilitySections({ ...base, isOwner: false, authorized: false }) ?? "";
    expect(plain).toContain("You are speaking with a member of this team.");
    expect(plain).not.toContain("trusted member");

    for (const text of [owner, trusted, plain]) {
      expect(text).not.toContain("alice");
      expect(text).not.toContain("bob");
    }
  });

  test("no wiki note when the team has no wiki", () => {
    config.teams = { other: { spaces: [{ surface: "slack", spaceId: "T1" }] } };
    const text = buildCapabilitySections(base) ?? "";
    expect(text).toContain("## Team");
    expect(text).not.toContain("wiki");
  });
});
