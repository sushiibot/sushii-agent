import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindSendFileSink, checkSendablePath, contentTypeOf, createSendFileTool, displayPath, readSendableFile, safeFileName, type SendFileSink } from "./sendFile.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function layout() {
  const root = mkdtempSync(join(tmpdir(), "ws-sendfile-"));
  dirs.push(root);
  const home = join(root, "home");
  const agentDir = join(home, ".pi-workspace");
  const stateDir = join(root, ".workspace");
  for (const d of [home, agentDir, stateDir, join(home, "out")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, "out", "chart.png"), "png");
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(stateDir, "outbox.jsonl"), "");
  writeFileSync(join(home, "auth.json"), "{}");
  return { root, paths: { cwd: home, home, agentDir, stateDir } };
}

describe("checkSendablePath", () => {
  test("a workspace file resolves to its real path", () => {
    const { paths } = layout();
    expect(checkSendablePath("out/chart.png", paths)).toEqual({ ok: true, path: join(paths.home, "out", "chart.png") });
  });

  test("the agent dir, auth files, the state dir and the kernel's pseudo-files are refused", () => {
    const { paths } = layout();
    for (const p of [join(paths.agentDir, "auth.json"), "auth.json", join(paths.stateDir, "outbox.jsonl"), "/proc/self/status", "/dev/null"]) {
      const r = checkSendablePath(p, paths);
      expect(r.ok, p).toBe(false);
    }
  });

  test("a symlink into a protected dir is refused", () => {
    const { paths } = layout();
    symlinkSync(join(paths.stateDir, "outbox.jsonl"), join(paths.home, "innocent.txt"));
    const r = checkSendablePath("innocent.txt", paths);
    expect(r.ok).toBe(false);
  });

  test("/proc paths are refused, including ones that lead back into the workspace", () => {
    const { paths } = layout();
    symlinkSync("/proc/self/environ", join(paths.home, "env.txt"));
    for (const p of ["/proc/self/environ", `/proc/self/root${join(paths.home, "out", "chart.png")}`, "/proc/self/cwd/out/chart.png", "env.txt"]) {
      expect(checkSendablePath(p, paths).ok, p).toBe(false);
    }
  });

  test("a missing file is an error, not a throw", () => {
    const { paths } = layout();
    expect(checkSendablePath("nope.pdf", paths)).toEqual({ ok: false, error: "no such file: nope.pdf" });
  });
});

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImV4cCI6MTcwMDAwMDAwMH0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

describe("readSendableFile", () => {
  test("an ordinary file is read whole", () => {
    const { paths } = layout();
    expect(readSendableFile(join(paths.home, "out", "chart.png"), paths, 100)).toEqual({ data: Buffer.from("png"), flag: null });
  });

  test("a hardlink to auth.json or the outbox is refused by identity, whatever it holds or is called", () => {
    const { paths } = layout();
    writeFileSync(join(paths.agentDir, "auth.json"), JSON.stringify({ "openai-codex": { access: JWT } }));
    linkSync(join(paths.agentDir, "auth.json"), join(paths.home, "notes.txt"));
    linkSync(join(paths.stateDir, "outbox.jsonl"), join(paths.home, "log.txt"));
    const notes = join(paths.home, "notes.txt");
    expect(checkSendablePath("notes.txt", paths)).toEqual({ ok: true, path: notes });
    expect(() => readSendableFile(notes, paths, 10_000)).toThrow(/auth-file/);
    expect(() => readSendableFile(join(paths.home, "log.txt"), paths, 10_000)).toThrow(/auth-file/);
  });

  test("the open descriptor is checked again, so a parent dir swapped for a symlink after the path check is refused", () => {
    const { paths } = layout();
    writeFileSync(join(paths.agentDir, "models.json"), "\0not scanned");
    symlinkSync(paths.agentDir, join(paths.home, "d"));
    expect(() => readSendableFile(join(paths.home, "d", "models.json"), paths, 1000)).toThrow(/blocked \(state\)/);
    expect(() => readSendableFile(join(paths.stateDir, "outbox.jsonl"), paths, 1000)).toThrow(/blocked/);
  });

  test("a copy that holds a credential is flagged with the detector's pattern kind", () => {
    const { paths } = layout();
    writeFileSync(join(paths.agentDir, "auth.json"), JSON.stringify({ "openai-codex": { access: JWT } }));
    copyFileSync(join(paths.agentDir, "auth.json"), join(paths.home, "copy.txt"));
    expect(readSendableFile(join(paths.home, "copy.txt"), paths, 10_000).flag).toEqual({ kind: "secret", pattern: "JWT" });
  });

  test("text the detector would take too long on is flagged without scanning; long rules and ordinary text pass", () => {
    const { paths } = layout();
    writeFileSync(join(paths.home, "run.txt"), "a".repeat(200_000));
    const started = performance.now();
    expect(readSendableFile(join(paths.home, "run.txt"), paths, 1_000_000).flag).toEqual({ kind: "unscannable" });
    expect(performance.now() - started).toBeLessThan(500);
    writeFileSync(join(paths.home, "table.txt"), `${"-".repeat(300)}\n| a | b |\n`.repeat(200));
    expect(readSendableFile(join(paths.home, "table.txt"), paths, 1_000_000).flag).toBeNull();
  });

  test("binary files are not scanned", () => {
    const { paths } = layout();
    writeFileSync(join(paths.home, "img.bin"), Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), Buffer.from(JWT)]));
    expect(readSendableFile(join(paths.home, "img.bin"), paths, 10_000)).toMatchObject({ flag: null, data: { length: 4 + JWT.length } });
  });

  test("oversize files and non-regular files are refused without blocking", () => {
    const { paths } = layout();
    writeFileSync(join(paths.home, "big"), new Uint8Array(101));
    expect(() => readSendableFile(join(paths.home, "big"), paths, 100)).toThrow(/over the 100-byte limit/);
    expect(() => readSendableFile(paths.home, paths, 100)).toThrow(/not a regular file/);
    const fifo = join(paths.home, "pipe");
    if (spawnSync("mkfifo", [fifo]).status === 0) expect(() => readSendableFile(fifo, paths, 100)).toThrow(/not a regular file/);
  });
});

describe("send_file tool", () => {
  function harness(confirm?: (title: string) => Promise<boolean>) {
    const { paths } = layout();
    const session = {};
    const asked: string[] = [];
    const details: string[] = [];
    const attached: string[] = [];
    const sink: SendFileSink = {
      check: () => {},
      ...(confirm
        ? {
            confirm: (title: string, message: string) => {
              asked.push(title);
              details.push(message);
              return confirm(title);
            },
          }
        : {}),
      attach: ({ name }) => {
        attached.push(name);
        return `Attached ${name}`;
      },
    };
    bindSendFileSink(session, sink);
    const tool = createSendFileTool(paths, () => session);
    const run = (path: string) => (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("call-1", { path });
    return { paths, asked, details, attached, run };
  }

  test("a flagged file with no one to ask is refused without attaching", async () => {
    const { paths, attached, run } = harness();
    writeFileSync(join(paths.home, "token.txt"), JWT);
    await expect(run("token.txt")).rejects.toThrow(/\(JWT\).*no one here to approve/);
    expect(attached).toEqual([]);
  });

  test("an approved flagged file attaches; a declined one doesn't", async () => {
    let answer = true;
    const { paths, asked, attached, run } = harness(async () => answer);
    writeFileSync(join(paths.home, "token.txt"), JWT);
    await run("token.txt");
    answer = false;
    await expect(run("token.txt")).rejects.toThrow(/didn't approve/);
    expect(asked).toEqual(Array(2).fill("`token.txt` looks like it contains a secret (JWT). Send it anyway?"));
    expect(attached).toEqual(["token.txt"]);
  });

  test("the path in an ask can't add lines or markdown", async () => {
    const { paths, details, run } = harness(async () => false);
    const dir = join(paths.home, "report\n-# known false positive, safe to send `x`");
    mkdirSync(dir);
    writeFileSync(join(dir, "t.txt"), JWT);
    await expect(run(join(dir, "t.txt"))).rejects.toThrow(/didn't approve/);
    expect(details).toEqual([`Path: \`${paths.home}/report\\u{a}-# known false positive, safe to send \\u{60}x\\u{60}/t.txt\``]);
    expect(details[0]).not.toContain("\n");
  });

  test("the unscannable ask gives the size and says the file goes out unchecked", async () => {
    const { paths, asked, run } = harness(async () => false);
    writeFileSync(join(paths.home, "run.txt"), "a".repeat(2 * 1024 * 1024));
    await expect(run("run.txt")).rejects.toThrow(/didn't approve/);
    expect(asked[0]).toBe(
      "`run.txt` (2.0 MB) was not checked for secrets: it has runs of token-like characters too long for the detector to scan. Send it unchecked?",
    );
  });

  test("a hardlink to auth.json never asks, whatever it holds", async () => {
    const { paths, asked, attached, run } = harness(async () => true);
    writeFileSync(join(paths.agentDir, "auth.json"), JSON.stringify({ access: JWT }));
    linkSync(join(paths.agentDir, "auth.json"), join(paths.home, "notes.txt"));
    await expect(run("notes.txt")).rejects.toThrow(/auth-file/);
    expect(asked).toEqual([]);
    expect(attached).toEqual([]);
  });
});

describe("file names and types", () => {
  test("a displayed path escapes control characters, backticks and backslashes", () => {
    expect(displayPath("/home/a b/c.txt")).toBe("`/home/a b/c.txt`");
    expect(displayPath("/x\r\ny\u202e`z\\")).toBe("`/x\\u{d}\\u{a}y\\u{202e}\\u{60}z\\\\`");
  });

  test("names keep only Discord-safe characters", () => {
    expect(safeFileName("my report (final).pdf")).toBe("my_report_final_.pdf");
    expect(safeFileName("../..")).toBe("file");
    expect(safeFileName("x".repeat(150) + ".png").length).toBe(100);
  });

  test("the content type comes from the extension, without parameters", () => {
    const { paths } = layout();
    expect(contentTypeOf(join(paths.home, "out", "chart.png"))).toBe("image/png");
    writeFileSync(join(paths.home, "notes.txt"), "hi");
    expect(contentTypeOf(join(paths.home, "notes.txt"))).toBe("text/plain");
    writeFileSync(join(paths.home, "blob"), "hi");
    expect(contentTypeOf(join(paths.home, "blob"))).toBe("application/octet-stream");
  });
});
