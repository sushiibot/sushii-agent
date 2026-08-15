import { describe, expect, test } from "bun:test";
import { SEND_INPUT } from "./mcpServer.ts";

describe("send tool input schema", () => {
  test("has exactly channel_id and content — no file, image, attachment, or identity override field", () => {
    const keys = Object.keys(SEND_INPUT.shape);
    expect(keys.sort()).toEqual(["channel_id", "content"]);
  });
});
