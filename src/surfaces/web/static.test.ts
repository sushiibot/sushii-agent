import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_CSP, TRUSTED_TYPE_POLICIES, buildCsp } from "./static.ts";

const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../../web/${path}`, import.meta.url)), "utf8");

describe("SPA CSP", () => {
  test("enforces Trusted Types with a fixed policy allowlist", () => {
    const directives = buildCsp(["'sha256-abc'"]).split("; ");
    expect(directives).toContain("require-trusted-types-for 'script'");
    expect(directives).toContain(`trusted-types ${TRUSTED_TYPE_POLICIES.join(" ")}`);
    expect(BASE_CSP).not.toContain("'allow-duplicates'");
    expect(BASE_CSP).not.toMatch(/trusted-types[^;]*\*/);
  });

  test("the web app creates its policy under the allowlisted name", () => {
    expect(TRUSTED_TYPE_POLICIES).toContain("sushii-sw-url");
    expect(web("src/lib/app/trusted-types.ts")).toContain("'sushii-sw-url'");
  });

  test("vite preview enforces the same allowlist the bot serves", () => {
    expect(web("vite.config.ts")).toContain(`const TRUSTED_TYPE_POLICIES = '${TRUSTED_TYPE_POLICIES.join(" ")}';`);
  });
});
