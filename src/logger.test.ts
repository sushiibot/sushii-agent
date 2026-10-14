import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import pino from "pino";
import { loggerOptions, scrubUrl } from "./logger.ts";
import { readDynamicSecret } from "./secrets.ts";

function capture(): { log: pino.Logger; output: () => string } {
  let out = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { log: pino(loggerOptions, stream), output: () => out };
}

describe("scrubUrl", () => {
  test("masks webhook and interaction path tokens and token-bearing query values", () => {
    expect(scrubUrl("https://discord.com/api/v10/webhooks/123/abcDEF_tok?wait=true")).toBe("https://discord.com/api/v10/webhooks/123/REDACTED?wait=true");
    expect(scrubUrl("https://discord.com/api/v10/interactions/456/aW50ZXJhY3Rpb24/callback")).toBe(
      "https://discord.com/api/v10/interactions/456/REDACTED/callback",
    );
    expect(scrubUrl("https://api.example.com/x?a=1&key=s3cret&b=2")).toBe("https://api.example.com/x?a=1&key=REDACTED&b=2");
  });
});

describe("logger redaction", () => {
  test("an error carrying a token in its URL is logged without the token", () => {
    const { log, output } = capture();
    const err = Object.assign(new Error("request failed"), { url: "https://discord.com/api/v10/webhooks/123/webhook-token-value" });
    log.error({ err }, "send failed");
    expect(output()).not.toContain("webhook-token-value");
    expect(output()).toContain("webhooks/123/REDACTED");
  });

  test("a loaded secret value inside an error is replaced", () => {
    process.env["SUSHII_TEST_LOGGER_SECRET"] = "loaded-secret-value-123";
    try {
      readDynamicSecret("SUSHII_TEST_LOGGER_SECRET");
      const { log, output } = capture();
      log.error({ err: new Error("upstream said: bad key loaded-secret-value-123") }, "call failed");
      expect(output()).not.toContain("loaded-secret-value-123");
      expect(output()).toContain("[REDACTED]");
    } finally {
      delete process.env["SUSHII_TEST_LOGGER_SECRET"];
    }
  });

  test("authorization headers are censored by path", () => {
    const { log, output } = capture();
    log.info({ req: { headers: { authorization: "Bearer header-secret" } }, headers: { Authorization: "Bearer other-secret" } }, "req");
    expect(output()).not.toContain("header-secret");
    expect(output()).not.toContain("other-secret");
  });
});
