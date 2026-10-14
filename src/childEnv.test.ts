import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { childEnv, gitEnv } from "./childEnv.ts";

describe("childEnv", () => {
  test("keeps the allowlist and extras, drops everything else", () => {
    const base = { PATH: "/bin", HOME: "/h", LC_ALL: "C", OPENAI_API_KEY: "k", SSH_AUTH_SOCK: "/s" };
    expect(childEnv({ X: "1" }, base)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", X: "1" });
  });

  test("git keeps the ssh-agent socket and its own auth env, not other secrets", () => {
    const base = { PATH: "/bin", SSH_AUTH_SOCK: "/s", WIKI_SYNC_HTTPS_TOKEN: "t" };
    expect(gitEnv({ GIT_SSH_COMMAND: "ssh" }, base)).toEqual({ PATH: "/bin", SSH_AUTH_SOCK: "/s", GIT_SSH_COMMAND: "ssh" });
  });

  // Bun.spawn's default env is a startup snapshot, so the secret must be in the parent's env at launch.
  test("a process spawned by the bot does not see an unrelated secret env var", async () => {
    const attachments = join(import.meta.dir, "modules/wiki-sync/attachments.ts");
    const script = `const { runSpawn } = await import(${JSON.stringify(attachments)});
const r = await runSpawn(["sh", "-c", "printenv SUSHII_TEST_FAKE_SECRET || echo unset"]);
console.log(r.stdout.trim());`;
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", OPENAI_API_KEY: "x", SUSHII_TEST_FAKE_SECRET: "leaked" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("unset");
  });
});
