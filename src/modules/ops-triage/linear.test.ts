import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import type { TeamConfig } from "../../orchestration/teams.ts";
import { secrets } from "../../secrets.ts";
import { __resetLinearWarnDedup, __setDefaultLinearApiKey, linearFor, resolveLinearAccount } from "./linear.ts";

// Placeholder credentials only — never a real API key or team id in a public repo.
const DEFAULT_KEY = "sushi-default-key";
const DEFAULT_TEAM = "SUSHI";

const TEAMS: Record<string, TeamConfig> = {
  // A team with NO linear must fall through to the default, never throw.
  nolinear: {
    spaces: [{ surface: "discord", spaceId: "1000000000000000009" }],
  },
  envkey: {
    spaces: [{ surface: "discord", spaceId: "1000000000000000010" }],
    linear: { apiKeyEnv: "TEST_ENVKEY_LINEAR_API_KEY", teamId: "ENVKEY" },
  },
  unsetenvkey: {
    spaces: [{ surface: "discord", spaceId: "1000000000000000011" }],
    linear: { apiKeyEnv: "TEST_UNSET_LINEAR_API_KEY", teamId: "UNSETENVKEY" },
  },
  teamx: {
    spaces: [{ surface: "slack", spaceId: "T000TEAMX0" }],
    linear: { apiKeyEnv: "TEST_TEAMX_LINEAR_API_KEY", teamId: "TEAMX" },
  },
};

describe("resolveLinearAccount", () => {
  const prevC = config.teams;
  const prevTeam = config.linearTeamId;
  beforeEach(() => {
    config.teams = TEAMS;
    __setDefaultLinearApiKey(DEFAULT_KEY);
    config.linearTeamId = DEFAULT_TEAM;
    process.env["TEST_ENVKEY_LINEAR_API_KEY"] = "envkey-key";
    delete process.env["TEST_UNSET_LINEAR_API_KEY"];
    delete process.env["TEST_TEAMX_LINEAR_API_KEY"];
    __resetLinearWarnDedup();
  });
  afterEach(() => {
    config.teams = prevC;
    __setDefaultLinearApiKey(secrets.LINEAR_API_KEY);
    config.linearTeamId = prevTeam;
    delete process.env["TEST_ENVKEY_LINEAR_API_KEY"];
    delete process.env["TEST_UNSET_LINEAR_API_KEY"];
    delete process.env["TEST_TEAMX_LINEAR_API_KEY"];
  });

  test("a team with apiKeyEnv resolves the key from the named env var", () => {
    expect(resolveLinearAccount("discord", "1000000000000000010")).toEqual({ apiKey: "envkey-key", teamId: "ENVKEY" });
  });

  test("apiKeyEnv naming an unset env var falls through to the default account, not a literal apiKey", () => {
    expect(resolveLinearAccount("discord", "1000000000000000011")).toEqual({ apiKey: DEFAULT_KEY, teamId: DEFAULT_TEAM });
  });

  test("an unreadable apiKeyEnv _FILE falls through to the default account instead of throwing", () => {
    process.env["TEST_UNSET_LINEAR_API_KEY_FILE"] = "/nonexistent/linear-key";
    try {
      expect(resolveLinearAccount("discord", "1000000000000000011")).toEqual({ apiKey: DEFAULT_KEY, teamId: DEFAULT_TEAM });
    } finally {
      delete process.env["TEST_UNSET_LINEAR_API_KEY_FILE"];
    }
  });

  test("a space in no team falls through to the SUSHI default", () => {
    expect(resolveLinearAccount("discord", "9999999999999999999")).toEqual({ apiKey: DEFAULT_KEY, teamId: DEFAULT_TEAM });
  });

  test("a team WITHOUT linear falls through to the default (never throws)", () => {
    expect(resolveLinearAccount("discord", "1000000000000000009")).toEqual({ apiKey: DEFAULT_KEY, teamId: DEFAULT_TEAM });
  });

  test("both team and default unconfigured → empty account (linearFor decides the throw)", () => {
    config.teams = {};
    __setDefaultLinearApiKey(undefined);
    config.linearTeamId = undefined;
    expect(resolveLinearAccount("discord", "any")).toEqual({ apiKey: "", teamId: "" });
  });
});

describe("linearFor — per-account caching", () => {
  const prevC = config.teams;
  const prevTeam = config.linearTeamId;
  beforeEach(() => {
    config.teams = TEAMS;
    __setDefaultLinearApiKey(DEFAULT_KEY);
    config.linearTeamId = DEFAULT_TEAM;
    process.env["TEST_ENVKEY_LINEAR_API_KEY"] = "envkey-key";
    process.env["TEST_TEAMX_LINEAR_API_KEY"] = "teamx-key";
  });
  afterEach(() => {
    config.teams = prevC;
    __setDefaultLinearApiKey(secrets.LINEAR_API_KEY);
    config.linearTeamId = prevTeam;
    delete process.env["TEST_ENVKEY_LINEAR_API_KEY"];
    delete process.env["TEST_TEAMX_LINEAR_API_KEY"];
  });

  test("two teams get distinct clients (no cross-account contamination)", () => {
    const envkey = linearFor("discord", "1000000000000000010");
    const teamx = linearFor("slack", "T000TEAMX0");
    expect(envkey).not.toBe(teamx);
  });

  test("repeated calls for the same account return the cached instance", () => {
    expect(linearFor("discord", "1000000000000000010")).toBe(linearFor("discord", "1000000000000000010"));
  });

  test("a team without linear and a no-team space share the default instance", () => {
    const viaNoLinear = linearFor("discord", "1000000000000000009");
    const viaNoTeam = linearFor("discord", "9999999999999999999");
    expect(viaNoLinear).toBe(viaNoTeam);
  });

  test("throws only when neither team nor default has a key", () => {
    config.teams = {};
    __setDefaultLinearApiKey(undefined);
    config.linearTeamId = undefined;
    expect(() => linearFor("discord", "any")).toThrow(/LINEAR_API_KEY is not configured/);
  });
});
