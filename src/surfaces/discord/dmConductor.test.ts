import { describe, expect, test } from "bun:test";
import { isPersonalSpace, spaceKey } from "../../orchestration/authz.ts";
import { DM_SPACE_ID, isOwnerDm } from "./dmConductor.ts";

const OWNER = "owner-123";

describe("isOwnerDm (CRITICAL guard: only the owner's own DMs are handled)", () => {
  test("the owner's own message is handled", () => {
    expect(isOwnerDm({ author: { bot: false, id: OWNER } }, OWNER)).toBe(true);
  });

  test("a non-owner's DM is ignored", () => {
    expect(isOwnerDm({ author: { bot: false, id: "some-random-user" } }, OWNER)).toBe(false);
  });

  test("a bot's own message (even if the id matched) is never handled — no self-conversation loop", () => {
    expect(isOwnerDm({ author: { bot: true, id: OWNER } }, OWNER)).toBe(false);
  });

  test("no owner configured -> nobody's DM is handled, including a matching id", () => {
    expect(isOwnerDm({ author: { bot: false, id: OWNER } }, undefined)).toBe(false);
  });
});

describe("DM_SPACE_ID matches authz's pinned personal-space allowlist exactly", () => {
  test("spaceKey('discord', DM_SPACE_ID) is a recognized personal space", () => {
    expect(isPersonalSpace(spaceKey("discord", DM_SPACE_ID))).toBe(true);
  });

  test("the emitted key is literally 'discord:dm', matching authz.ts's hardcoded allowlist entry", () => {
    expect(spaceKey("discord", DM_SPACE_ID)).toBe("discord:dm");
  });

  test("a guild spaceId is never treated as personal (guild spaces stay denied)", () => {
    expect(isPersonalSpace(spaceKey("discord", "some-guild-id"))).toBe(false);
  });
});
