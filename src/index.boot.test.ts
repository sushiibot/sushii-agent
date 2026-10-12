import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const READY = "MCP bridge HTTP server listening";

function freePort(): Promise<number> {
  const srv = net.createServer();
  return new Promise((res, rej) =>
    srv.once("error", rej).listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(port));
    }),
  );
}

test("the bot boots on the bot env alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-boot-"));
  writeFileSync(join(dir, "principals.json"), "{}");
  writeFileSync(join(dir, "teams.json"), "{}");
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./src/test/discordLoginStub.preload.ts", "src/index.ts"], {
    cwd: ROOT,
    // Built from scratch so the host's env can't satisfy a requirement the deploy doesn't set.
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: dir,
      DISCORD_BOT_TOKEN: "boot-test",
      OPENAI_API_KEY: "boot-test",
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      DATABASE_PATH: join(dir, "sushii-agent.db"),
      FEEDBACK_PATH: join(dir, "feedback"),
      PRINCIPALS_PATH: join(dir, "principals.json"),
      TEAMS_PATH: join(dir, "teams.json"),
      MCP_BRIDGE_PORT: String(await freePort()),
      WIKI_SYNC_CLONE_DIR: join(dir, "wiki", "repo"),
      WIKI_SYNC_INBOX_DIR: join(dir, "wiki", "inbox"),
      WIKI_SYNC_AGENT_DIR: join(dir, "wiki", "agent"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 20_000;
    while (!out.includes(READY) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
      if (!chunk || chunk.done) break;
      out += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    if (!out.includes(READY)) proc.kill("SIGKILL");
    const err = out.includes(READY) ? "" : await new Response(proc.stderr).text();
    expect({ ready: out.includes(READY), err }).toEqual({ ready: true, err: "" });
  } finally {
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, Bun.sleep(5000).then(() => proc.kill("SIGKILL"))]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
