import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWebConfig, resolveOwnerPrincipals, resolveTeamsConfig, teamGuildConfigs } from "./config.ts";
import type { PrincipalConfig } from "./orchestration/principals.ts";
import type { TeamConfig } from "./orchestration/teams.ts";

function fakeReadFile(files: Record<string, string>): (filePath: string) => string {
  return (filePath) => {
    const content = files[filePath];
    if (content === undefined) throw new Error(`ENOENT: no such file, open '${filePath}'`);
    return content;
  };
}

describe("resolveOwnerPrincipals", () => {
  test("missing/empty registry + OWNER_DISCORD_ID set synthesizes a single owner principal", () => {
    const warn = mock();
    expect(resolveOwnerPrincipals({}, "100000000000000000", warn)).toEqual({
      owner: { owner: true, identities: { discord: "100000000000000000" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("neither set stays empty — nobody is owner, no warning", () => {
    const warn = mock();
    expect(resolveOwnerPrincipals({}, undefined, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("a non-empty registry is used as-is, never merged with OWNER_DISCORD_ID", () => {
    const raw: Record<string, PrincipalConfig> = {
      drk: { owner: true, identities: { discord: "100000000000000000", slack: "U1" } },
      alice: { identities: { discord: "200000000000000000" } },
    };
    expect(resolveOwnerPrincipals(raw, "999999999999999999")).toBe(raw);
  });

  test("a registry with members but no declared owner is used as-is, not synthesized over, no warning", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { alice: { identities: { discord: "200000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000", warn)).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a matching file owner + OWNER_DISCORD_ID logs no warning and returns the file as-is", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "100000000000000000", warn)).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a mismatched file owner + OWNER_DISCORD_ID warns once and still returns the file as-is (file wins)", () => {
    const warn = mock();
    const raw: Record<string, PrincipalConfig> = { drk: { owner: true, identities: { discord: "100000000000000000" } } };
    expect(resolveOwnerPrincipals(raw, "999999999999999999", warn)).toBe(raw);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({
      principalId: "drk",
      fileOwnerDiscord: "100000000000000000",
      ownerDiscordId: "999999999999999999",
    });
  });
});

describe("resolveTeamsConfig", () => {
  test("loads teams.json from the default path when TEAMS_PATH is unset", () => {
    const readFile = fakeReadFile({ "./teams.json": JSON.stringify({ a: { spaces: [] } }) });
    expect(resolveTeamsConfig(undefined, readFile)).toEqual({
      a: { spaces: [], wiki: undefined, linear: undefined, members: undefined, trustSpaceMembers: undefined },
    });
  });

  test("loads teams.json from an explicit TEAMS_PATH", () => {
    const readFile = fakeReadFile({ "/custom/teams.json": JSON.stringify({ a: { spaces: [] } }) });
    expect(resolveTeamsConfig("/custom/teams.json", readFile)).toEqual({
      a: { spaces: [], wiki: undefined, linear: undefined, members: undefined, trustSpaceMembers: undefined },
    });
  });

  test("an explicit TEAMS_PATH that can't be read throws", () => {
    const readFile = fakeReadFile({});
    expect(() => resolveTeamsConfig("/custom/teams.json", readFile)).toThrow(/Failed to load teams from \/custom\/teams\.json/);
  });

  test("TEAMS_PATH unset + default teams.json missing → empty, no error", () => {
    const readFile = fakeReadFile({});
    expect(resolveTeamsConfig(undefined, readFile)).toEqual({});
  });

  test("TEAMS_PATH unset + default teams.json present but invalid JSON still throws (not swallowed as 'no teams')", () => {
    const readFile = fakeReadFile({ "./teams.json": "not json" });
    expect(() => resolveTeamsConfig(undefined, readFile)).toThrow(/Invalid teams JSON in \.\/teams\.json/);
  });

  test("TEAMS_PATH unset + default teams.json present but shape-invalid still throws", () => {
    const readFile = fakeReadFile({ "./teams.json": JSON.stringify({ a: { spaces: "not an array" } }) });
    expect(() => resolveTeamsConfig(undefined, readFile)).toThrow(/teams: "a"\.spaces must be an array/);
  });
});

describe("teamGuildConfigs", () => {
  test("derives a guild config from a discord block, folding the space's statusChannelId into wiki", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: {
        spaces: [
          {
            surface: "discord",
            spaceId: "1000000000000000001",
            statusChannelId: "s1",
            discord: { allowedRoles: ["r1"], promptTemplate: "general" },
          },
        ],
      },
    };
    expect(teamGuildConfigs(teams)).toEqual({
      "1000000000000000001": { allowedRoles: ["r1"], promptTemplate: "general", wiki: { statusChannelId: "s1" } },
    });
  });

  test("a space with no discord block contributes nothing, even with a statusChannelId", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: { spaces: [{ surface: "discord", spaceId: "1000000000000000001", statusChannelId: "s1" }] },
    };
    expect(teamGuildConfigs(teams)).toEqual({});
  });

  test("a discord block with no space-level statusChannelId passes through untouched", () => {
    const teams: Record<string, TeamConfig> = {
      dreamcatcher: {
        spaces: [{ surface: "discord", spaceId: "g1", discord: { allowedRoles: ["r1"] } }],
      },
    };
    expect(teamGuildConfigs(teams)).toEqual({ g1: { allowedRoles: ["r1"] } });
  });
});

describe("parseWebConfig", () => {
  const vapid = { VAPID_PUBLIC_KEY: "BPubKey_-", VAPID_PRIVATE_KEY: "privKey-_", VAPID_SUBJECT: "mailto:me@example.com" };

  test("disabled when WEB_OWNER_LOGIN is unset or blank, even with other web vars invalid", () => {
    expect(parseWebConfig({})).toBeUndefined();
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "  ", WEB_PORT: "nope", VAPID_PUBLIC_KEY: "x" })).toBeUndefined();
  });

  test("defaults, with push off when the VAPID keys are absent", () => {
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me@example.com" })).toEqual({
      port: 8790,
      bindAddr: "127.0.0.1",
      ownerLogin: "me@example.com",
      distDir: "/app/web/build",
      devLogin: undefined,
      trustedPeers: ["127.0.0.1"],
      push: undefined,
    });
  });

  test("push on with both keys and a subject", () => {
    const web = parseWebConfig({ WEB_OWNER_LOGIN: "me@example.com", ...vapid, WEB_TRUSTED_PEERS: "127.0.0.1, 172.31.250.1", WEB_BIND_ADDR: "172.31.250.2" });
    expect(web?.push).toEqual({ publicKey: "BPubKey_-", privateKey: "privKey-_", subject: "mailto:me@example.com" });
    expect(web?.trustedPeers).toEqual(["127.0.0.1", "172.31.250.1"]);
    expect(web?.bindAddr).toBe("172.31.250.2");
  });

  test("a half-configured VAPID pair or a missing subject turns push off with a reason", () => {
    const half = parseWebConfig({ WEB_OWNER_LOGIN: "me", VAPID_PUBLIC_KEY: "abc" });
    expect(half?.push).toBeUndefined();
    expect(half?.pushDisabledReason).toContain("set together");
    const noSubject = parseWebConfig({ WEB_OWNER_LOGIN: "me", VAPID_PUBLIC_KEY: "abc", VAPID_PRIVATE_KEY: "def" });
    expect(noSubject?.push).toBeUndefined();
    expect(noSubject?.pushDisabledReason).toContain("VAPID_SUBJECT");
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", ...vapid, VAPID_PRIVATE_KEY: "padded==" })?.push?.privateKey).toBe("padded==");
    expect(() => parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_PORT: "70000" })).toThrow();
  });

  test("importing config never parses the web env, so a bad web setup cannot crash the bot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cfg-import-"));
    try {
      const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(join(import.meta.dir, "config.ts"))}); console.log("imported")`], {
        cwd,
        // An explicit env, not the parent's, so a local .env cannot fill in the missing VAPID half.
        env: {
          PATH: process.env["PATH"] ?? "",
          DISCORD_BOT_TOKEN: "x",
          OPENAI_API_KEY: "x",
          WEB_OWNER_LOGIN: "me@example.com",
          VAPID_PUBLIC_KEY: "BAAA",
          WEB_PORT: "nope",
          WEB_TRUSTED_PEERS: "10.0.0.0/8",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
      expect(out).toContain("imported");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("trusted peers are exact IPs and the bind address must be an IP", () => {
    expect(() => parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_TRUSTED_PEERS: "172.31.250.0/24" })).toThrow("exact IPs");
    expect(() => parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_TRUSTED_PEERS: " , " })).toThrow();
    expect(() => parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_BIND_ADDR: "0.0.0.0/0" })).toThrow();
    expect(() => parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_BIND_ADDR: "localhost" })).toThrow();
  });

  test("WEB_DEV_LOGIN is honoured only on a loopback bind outside production", () => {
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_DEV_LOGIN: "me" })?.devLogin).toBe("me");
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_DEV_LOGIN: "me", WEB_BIND_ADDR: "::1" })?.devLogin).toBe("me");
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_DEV_LOGIN: "me", NODE_ENV: "production" })?.devLogin).toBeUndefined();
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_DEV_LOGIN: "me", NODE_ENV: "PRODUCTION" })?.devLogin).toBeUndefined();
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_DEV_LOGIN: "me", WEB_BIND_ADDR: "172.31.250.2" })?.devLogin).toBeUndefined();
    expect(parseWebConfig({ WEB_OWNER_LOGIN: "me", WEB_DEV_LOGIN: "me", WEB_BIND_ADDR: "0.0.0.0" })?.devLogin).toBeUndefined();
  });
});
