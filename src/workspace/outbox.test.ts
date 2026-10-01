import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStoreName, Outbox } from "./outbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-outbox-"));
  dirs.push(d);
  return d;
}

const entry = (outboxId: string) => ({ outboxId, principalId: "drk", kind: "reply" as const, text: "hi" });

describe("outbox files", () => {
  test("a staged file is stored by name, read back at send, survives a restart and is deleted on ack", () => {
    const state = temp();
    const outbox = new Outbox(state);
    const staged = outbox.stage(Buffer.from("v1"), "a.txt", "text/plain", 100);
    expect(staged.file).not.toContain("/");
    outbox.append({ ...entry("o1"), stagedFiles: [staged] });

    const reloaded = new Outbox(state);
    const [pending] = reloaded.unacked();
    expect(reloaded.wire(pending!).files).toEqual([{ name: "a.txt", contentType: "text/plain", dataBase64: Buffer.from("v1").toString("base64") }]);
    expect(reloaded.ack("o1")).toBe(true);
    expect(existsSync(join(outbox.filesDir, staged.file))).toBe(false);
  });

  test("staging refuses oversize data", () => {
    const outbox = new Outbox(temp());
    expect(() => outbox.stage(Buffer.alloc(101), "big", "application/octet-stream", 100)).toThrow(/over the 100-byte limit/);
  });

  test("a staged copy changed after staging is left out and noted, even at the same size", () => {
    const outbox = new Outbox(temp());
    const staged = outbox.stage(Buffer.from("innocent"), "a.txt", "text/plain", 100);
    outbox.append({ ...entry("o1"), stagedFiles: [staged] });
    writeFileSync(join(outbox.filesDir, staged.file), "SECRETXX");
    const wire = outbox.wire(outbox.unacked()[0]!);
    expect(wire.files).toBeUndefined();
    expect(wire.text).toContain("couldn't attach: a.txt");
  });

  test("a staged file that is gone is noted in the text; unreferenced files are swept on load", () => {
    const state = temp();
    const outbox = new Outbox(state);
    const missing = { name: "gone.png", contentType: "image/png", file: "gone.png", bytes: 3, sha256: "0" };
    outbox.append({ ...entry("o1"), stagedFiles: [missing] });
    const wire = outbox.wire(outbox.unacked()[0]!);
    expect(wire.files).toBeUndefined();
    expect(wire.text).toContain("couldn't attach: gone.png");

    mkdirSync(outbox.filesDir, { recursive: true });
    writeFileSync(join(outbox.filesDir, "orphan"), "x");
    new Outbox(state);
    expect(readdirSync(outbox.filesDir)).toEqual([]);
  });
});

describe("outbox file names from disk", () => {
  function forged(state: string, file: string) {
    mkdirSync(state, { recursive: true });
    const line = { type: "entry", entry: { ...entry("f1"), stagedFiles: [{ name: "notes.txt", contentType: "text/plain", file, bytes: 6, sha256: "00" }] } };
    writeFileSync(join(state, "outbox.jsonl"), `${JSON.stringify(line)}\n`);
  }

  test("only a plain name inside the store is accepted", () => {
    for (const bad of ["../x", "a/b", "/etc/passwd", ".", "..", "", "a\0b", 3, null]) expect(isStoreName(bad), String(bad)).toBe(false);
    expect(isStoreName("0b7c-chart.png")).toBe(true);
  });

  test("a forged entry pointing outside the store neither reads nor deletes the target", () => {
    const root = temp();
    const state = join(root, ".workspace");
    const victim = join(root, "auth.json");
    writeFileSync(victim, "SECRET");
    forged(state, "../auth.json");
    const outbox = new Outbox(state);
    const [loaded] = outbox.unacked();
    expect(loaded!.stagedFiles).toEqual([]);
    expect(outbox.wire(loaded!).files).toBeUndefined();
    expect(outbox.ack("f1")).toBe(true);
    expect(existsSync(victim)).toBe(true);
  });

  test("wire and discard refuse an escaping name even on an in-memory entry", () => {
    const root = temp();
    const outbox = new Outbox(join(root, ".workspace"));
    const victim = join(root, "keep.txt");
    writeFileSync(victim, "SECRET");
    const escaping = { name: "keep.txt", contentType: "text/plain", file: "../keep.txt", bytes: 6, sha256: "00" };
    outbox.append({ ...entry("o1"), stagedFiles: [escaping] });
    const wire = outbox.wire(outbox.unacked()[0]!);
    expect(wire.files).toBeUndefined();
    expect(wire.text).toContain("couldn't attach: keep.txt");
    outbox.ack("o1");
    expect(existsSync(victim)).toBe(true);
  });

  test("a symlink planted in the store is not followed", () => {
    const root = temp();
    const outbox = new Outbox(join(root, ".workspace"));
    const staged = outbox.stage(Buffer.from("SECRET"), "a.txt", "text/plain", 100);
    const target = join(root, "secret.txt");
    writeFileSync(target, "SECRET");
    rmSync(join(outbox.filesDir, staged.file));
    symlinkSync(target, join(outbox.filesDir, staged.file));
    outbox.append({ ...entry("o1"), stagedFiles: [staged] });
    expect(outbox.wire(outbox.unacked()[0]!).files).toBeUndefined();
  });
});

test("files that would push the delivery past one WebSocket frame are left out and noted", () => {
  const outbox = new Outbox(temp());
  const staged = outbox.stage(Buffer.alloc(1024), "a.bin", "application/octet-stream", 2048);
  outbox.append({ ...entry("o1"), text: "x".repeat(16 * 1024 * 1024), stagedFiles: [staged] });
  const wire = outbox.wire(outbox.unacked()[0]!);
  expect(wire.files).toBeUndefined();
  expect(wire.text.endsWith("(couldn't attach: a.bin)")).toBe(true);
});

describe("outbox replace", () => {
  test("replaces a pending entry in place, across a reload, and refuses an acked or unknown one", () => {
    const state = temp();
    const outbox = new Outbox(state);
    outbox.append(entry("o1"));
    outbox.append(entry("o2"));
    expect(outbox.replace({ ...entry("o1"), kind: "proactive", text: "rewritten" })).toBe(true);
    outbox.ack("o2");
    expect(outbox.replace(entry("o2"))).toBe(false);
    expect(outbox.replace(entry("o3"))).toBe(false);
    const reloaded = new Outbox(state);
    expect(reloaded.unacked()).toEqual([{ ...entry("o1"), kind: "proactive", text: "rewritten" }]);
  });
});
