import { describe, expect, test } from "bun:test";
import type { TaskRow } from "./contracts.ts";
import { buildResumeCommand, buildTaskMeta } from "./taskMeta.ts";

describe("buildResumeCommand", () => {
  test("claude-code → a cd + claude --resume command, cwd shell-quoted", () => {
    expect(buildResumeCommand("claude-code", "/home/drk/my repo", "abc-123")).toBe("cd '/home/drk/my repo' && claude --resume abc-123");
  });
  test("pi → null (not cleanly resumable from a bare terminal)", () => {
    expect(buildResumeCommand("pi", "/data/x", "/data/sessions/s.jsonl")).toBeNull();
  });
  test("null when there is no native session", () => {
    expect(buildResumeCommand("claude-code", "/x", null)).toBeNull();
  });
});

describe("buildTaskMeta", () => {
  const row = { id: "t1", runnerId: "cloud", project: "sushii-agent", cwd: "/data/x", nativeSessionId: "s1" } as TaskRow;

  test("assembles runner/location/project/path + resume from the runner kind", () => {
    const meta = buildTaskMeta(row, { kind: "claude-code", location: "drk-wsl2 · desktop" });
    expect(meta).toMatchObject({ runnerId: "cloud", kind: "claude-code", location: "drk-wsl2 · desktop", project: "sushii-agent", cwd: "/data/x" });
    expect(meta.resumeCommand).toBe("cd '/data/x' && claude --resume s1");
  });

  test("unknown runner (offline) → kind '?', no resume", () => {
    const meta = buildTaskMeta(row, undefined);
    expect(meta.kind).toBe("?");
    expect(meta.resumeCommand).toBeNull();
  });
});
