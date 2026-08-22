import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.ts";
import { resolveGitAuth } from "./git.ts";

let originalHttpsToken: string | undefined;
let originalSshAuthSock: string | undefined;

beforeEach(() => {
  originalHttpsToken = config.wikiSyncHttpsToken;
  originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
});

afterEach(() => {
  config.wikiSyncHttpsToken = originalHttpsToken;
  if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
  else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
});

describe("resolveGitAuth", () => {
  test("ssh:// uses GIT_SSH_COMMAND and no config pairs when SSH_AUTH_SOCK is set", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/fake-agent-sock";
    const auth = resolveGitAuth("ssh://git@example.com:2222/org/repo.git");
    expect(auth.env["GIT_SSH_COMMAND"]).toContain("ssh");
    expect(auth.configPairs).toEqual([]);
  });

  test("ssh:// throws when SSH_AUTH_SOCK is not set", () => {
    delete process.env["SSH_AUTH_SOCK"];
    expect(() => resolveGitAuth("ssh://git@example.com:2222/org/repo.git")).toThrow(/ssh-agent/);
  });

  test("https:// builds a Basic auth header from the token, not embedded in the URL", () => {
    config.wikiSyncHttpsToken = "my-token";
    const auth = resolveGitAuth("https://example.com/org/repo.git");
    expect(auth.env).toEqual({});
    expect(auth.configPairs.length).toBe(1);
    const [key, value] = auth.configPairs[0]!;
    expect(key).toBe("http.extraHeader");
    expect(value).toBe(`Authorization: Basic ${Buffer.from("oauth2:my-token").toString("base64")}`);
  });

  test("https:// throws when WIKI_SYNC_HTTPS_TOKEN is not set", () => {
    config.wikiSyncHttpsToken = undefined;
    expect(() => resolveGitAuth("https://example.com/org/repo.git")).toThrow(/WIKI_SYNC_HTTPS_TOKEN/);
  });

  test("throws for an unsupported scheme", () => {
    expect(() => resolveGitAuth("git://example.com/org/repo.git")).toThrow(/unsupported scheme/);
  });
});
