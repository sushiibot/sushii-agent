import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "../../contracts.ts";
import { config } from "../../../config.ts";
import type { PrincipalConfig } from "../../../orchestration/principals.ts";
import { fileLinearIssueEntry } from "./tools.ts";

// Only the DENIAL branches are exercised here — they return before any network call. The positive
// (owner) path reaches Linear, so owner visibility is covered by the registry test instead.
function ctx(surface: "discord" | "slack", userId: string | undefined): ToolContext {
  return {
    space: { surface, spaceId: "s1" },
    owner: userId ? { userId, displayName: "x" } : null,
  } as unknown as ToolContext;
}

const OWNER: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
const NONOWNER: Record<string, PrincipalConfig> = { alice: { identities: { discord: "200000000000000000" } } };

describe("ops-triage owner gate — UNCONFIGURED (legacy ownerDiscordId)", () => {
  const prevP = config.principals;
  const prevOwner = config.ownerDiscordId;
  afterEach(() => {
    config.principals = prevP;
    config.ownerDiscordId = prevOwner;
  });

  test("no ownerDiscordId → reports unconfigured", async () => {
    config.principals = {};
    config.ownerDiscordId = undefined;
    const r = await fileLinearIssueEntry.execute({ title: "t", description: "d", repo_label: "r" }, ctx("discord", "anyone"));
    expect(r.content).toContain("not configured");
  });

  test("wrong user → owner-only denial", async () => {
    config.principals = {};
    config.ownerDiscordId = "100000000000000000";
    const r = await fileLinearIssueEntry.execute({ title: "t", description: "d", repo_label: "r" }, ctx("discord", "999"));
    expect(r.content).toBe("This tool is owner-only.");
  });
});

describe("ops-triage owner gate — CONFIGURED (principal registry)", () => {
  const prevP = config.principals;
  afterEach(() => {
    config.principals = prevP;
  });

  test("a non-owner principal is denied", async () => {
    config.principals = { ...OWNER, ...NONOWNER };
    const r = await fileLinearIssueEntry.execute({ title: "t", description: "d", repo_label: "r" }, ctx("discord", "200000000000000000"));
    expect(r.content).toBe("This tool is owner-only.");
  });

  test("an unlinked user is denied", async () => {
    config.principals = OWNER;
    const r = await fileLinearIssueEntry.execute({ title: "t", description: "d", repo_label: "r" }, ctx("discord", "someone-else"));
    expect(r.content).toBe("This tool is owner-only.");
  });

  test("configured registry ignores a bare ownerDiscordId match (must be a linked owner principal)", async () => {
    config.principals = OWNER;
    // Right raw id, but resolved on the WRONG surface → not the owner principal here.
    const r = await fileLinearIssueEntry.execute({ title: "t", description: "d", repo_label: "r" }, ctx("slack", "100000000000000000"));
    expect(r.content).toBe("This tool is owner-only.");
  });
});
