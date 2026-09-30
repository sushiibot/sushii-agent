import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSendablePath, contentTypeOf, safeFileName } from "./sendFile.ts";

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

  test("a missing file is an error, not a throw", () => {
    const { paths } = layout();
    expect(checkSendablePath("nope.pdf", paths)).toEqual({ ok: false, error: "no such file: nope.pdf" });
  });
});

describe("file names and types", () => {
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
