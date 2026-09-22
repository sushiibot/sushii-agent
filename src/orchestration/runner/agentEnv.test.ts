import { describe, expect, test } from "bun:test";
import { buildAgentEnv } from "./agentEnv.ts";

describe("buildAgentEnv", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    OPENAI_API_KEY: "sk-or-secret",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    ORCH_URL: "ws://sushii_agent:8788",
  };

  test("keeps only allowlisted vars", () => {
    expect(buildAgentEnv(base)).toEqual({ PATH: "/usr/bin", HOME: "/root", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
  });

  test("layers the extra (git/gh) env on top", () => {
    const env = buildAgentEnv(base, { GH_TOKEN: "ghs_tok", PATH: "/opt/bin:/usr/bin" });
    expect(env.GH_TOKEN).toBe("ghs_tok");
    expect(env.PATH).toBe("/opt/bin:/usr/bin");
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
