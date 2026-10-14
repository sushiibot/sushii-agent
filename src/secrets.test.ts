import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets } from "./secrets.ts";

describe("loadSecrets", () => {
  test("a missing required secret names the variable and never echoes a value", () => {
    const env = { OPENAI_API_KEY: "", SLACK_BOT_TOKEN: "xoxb-should-not-appear" };
    let message = "";
    try {
      loadSecrets(env);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).not.toContain("xoxb-should-not-appear");
  });

  test("NAME_FILE is read when set, trailing newline trimmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    try {
      const file = join(dir, "openai");
      writeFileSync(file, "from-file-key\n");
      expect(loadSecrets({ OPENAI_API_KEY_FILE: file }).OPENAI_API_KEY).toBe("from-file-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable NAME_FILE names the variable and the error code only", () => {
    expect(() => loadSecrets({ OPENAI_API_KEY_FILE: "/nonexistent/openai" })).toThrow("OPENAI_API_KEY_FILE could not be read (ENOENT)");
  });

  test("an empty optional secret counts as unset, and the result is frozen", () => {
    const loaded = loadSecrets({ OPENAI_API_KEY: "k", LINEAR_API_KEY: "" });
    expect(loaded.LINEAR_API_KEY).toBeUndefined();
    expect(Object.isFrozen(loaded)).toBe(true);
  });
});
