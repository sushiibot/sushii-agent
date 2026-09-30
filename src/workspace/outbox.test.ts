import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "./outbox.ts";

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
  test("a staged file is snapshotted, read back at send, survives a restart and is deleted on ack", () => {
    const state = temp();
    const src = join(temp(), "a.txt");
    writeFileSync(src, "v1");
    const outbox = new Outbox(state);
    const staged = outbox.stage(src, "a.txt", "text/plain", 100);
    writeFileSync(src, "v2 changed");
    outbox.append({ ...entry("o1"), stagedFiles: [staged] });

    const reloaded = new Outbox(state);
    const [pending] = reloaded.unacked();
    expect(reloaded.wire(pending!).files).toEqual([{ name: "a.txt", contentType: "text/plain", dataBase64: Buffer.from("v1").toString("base64") }]);
    expect(reloaded.ack("o1")).toBe(true);
    expect(existsSync(staged.path)).toBe(false);
  });

  test("staging refuses oversize files and non-regular files", () => {
    const outbox = new Outbox(temp());
    const dir = temp();
    writeFileSync(join(dir, "big"), new Uint8Array(101));
    expect(() => outbox.stage(join(dir, "big"), "big", "application/octet-stream", 100)).toThrow(/over the 100-byte limit/);
    expect(() => outbox.stage(dir, "d", "application/octet-stream", 100)).toThrow(/not a regular file/);
  });

  test("a staged file that is gone is noted in the text; unreferenced files are swept on load", () => {
    const state = temp();
    const outbox = new Outbox(state);
    const missing = { name: "gone.png", contentType: "image/png", path: join(outbox.filesDir, "gone.png"), bytes: 3 };
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
