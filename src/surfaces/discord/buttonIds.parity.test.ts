// Parity tests: the NEW buttonIds constants must match the golden literal values
// pinned in characterization/buttonIds.characterization.test.ts.
import { describe, expect, test } from "bun:test";
import {
  ASK_BTN_PREFIX,
  AUTOMOD_BTN_PREFIX,
  AUTOMOD_DEL_BTN_PREFIX,
  FEEDBACK_BTN_PREFIX,
  SCAN_BTN_PREFIX,
  STOP_BTN_PREFIX,
} from "./buttonIds.ts";

describe("button customId prefix constants", () => {
  test("prefixes", () => {
    expect(STOP_BTN_PREFIX).toBe("stop:");
    expect(ASK_BTN_PREFIX).toBe("agq:");
    expect(FEEDBACK_BTN_PREFIX).toBe("fb:");
    expect(SCAN_BTN_PREFIX).toBe("srv:");
    expect(AUTOMOD_BTN_PREFIX).toBe("amka:");
    expect(AUTOMOD_DEL_BTN_PREFIX).toBe("amkd:");
  });
});

describe("composed customId golden values", () => {
  const threadId = "999999999999999999";
  const guildId = "888888888888888888";

  test("stop button: stop:{threadId}", () => {
    expect(`${STOP_BTN_PREFIX}${threadId}`).toBe("stop:999999999999999999");
  });

  test("ask_question button: agq:{threadId}:{choiceIndex}", () => {
    expect(`${ASK_BTN_PREFIX}${threadId}:0`).toBe("agq:999999999999999999:0");
    expect(`${ASK_BTN_PREFIX}${threadId}:2`).toBe("agq:999999999999999999:2");
  });

  test("feedback buttons: fb:{threadId}:{up|down}", () => {
    expect(`${FEEDBACK_BTN_PREFIX}${threadId}:up`).toBe("fb:999999999999999999:up");
    expect(`${FEEDBACK_BTN_PREFIX}${threadId}:down`).toBe("fb:999999999999999999:down");
  });

  test("server scan approval buttons: srv:{guildId}:{yes|no}", () => {
    expect(`${SCAN_BTN_PREFIX}${guildId}:yes`).toBe("srv:888888888888888888:yes");
    expect(`${SCAN_BTN_PREFIX}${guildId}:no`).toBe("srv:888888888888888888:no");
  });

  test("automod keyword-add approval buttons: amka:{threadId}:{approve|reject}", () => {
    expect(`${AUTOMOD_BTN_PREFIX}${threadId}:approve`).toBe("amka:999999999999999999:approve");
    expect(`${AUTOMOD_BTN_PREFIX}${threadId}:reject`).toBe("amka:999999999999999999:reject");
  });

  test("automod keyword-delete approval buttons: amkd:{threadId}:{approve|reject}", () => {
    expect(`${AUTOMOD_DEL_BTN_PREFIX}${threadId}:approve`).toBe("amkd:999999999999999999:approve");
    expect(`${AUTOMOD_DEL_BTN_PREFIX}${threadId}:reject`).toBe("amkd:999999999999999999:reject");
  });
});
