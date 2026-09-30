import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { isVerifiedWebActor, mintWebActor } from "./actor.ts";

describe("web actor", () => {
  test("only the minted object is verified: not a copy, not a look-alike", () => {
    const actor = mintWebActor("  Owner@GitHub ", "Owner");
    expect(actor).toEqual({ surface: "web", userId: "owner@github", name: "Owner" });
    expect(isVerifiedWebActor(actor)).toBe(true);
    expect(isVerifiedWebActor({ ...actor })).toBe(false);
    expect(isVerifiedWebActor({ surface: "web", userId: "owner@github", name: "Owner" })).toBe(false);
    expect(Object.isFrozen(actor)).toBe(true);
  });

  test("only the web gateway mints actors, after its login check", async () => {
    const callers: string[] = [];
    const src = join(import.meta.dir, "../..");
    for await (const file of new Glob("**/*.ts").scan(src)) {
      if (file.endsWith(".test.ts") || file === join("surfaces", "web", "actor.ts")) continue;
      if ((await Bun.file(join(src, file)).text()).includes("mintWebActor")) callers.push(file);
    }
    expect(callers).toEqual([join("surfaces", "web", "server.ts")]);
  });
});
