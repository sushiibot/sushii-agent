import { describe, expect, test } from "bun:test";
import { SessionStore } from "./session.ts";

const identity = { id: "u1", username: "alice", avatar: null };

describe("SessionStore", () => {
  test("mints a token distinct from any upstream token and resolves it back to the session", () => {
    const store = new SessionStore();
    const discordToken = "discord-access-token-not-ours";
    const token = store.mint({ identity, permittedGuildIds: ["a"] });

    expect(token).not.toBe(discordToken);
    expect(store.verify(token)).toEqual({ identity, permittedGuildIds: ["a"] });
  });

  test("rejects a token that isn't in the session map at all", () => {
    const store = new SessionStore();
    expect(store.verify("discord-access-token-not-ours")).toBeNull();
  });

  test("rejects a token past its TTL", () => {
    const store = new SessionStore(-1); // already-expired TTL
    const token = store.mint({ identity, permittedGuildIds: ["a"] });
    expect(store.verify(token)).toBeNull();
  });

  test("a user whitelisted in multiple guilds gets a session covering all of them", () => {
    const store = new SessionStore();
    const token = store.mint({ identity, permittedGuildIds: ["a", "b"] });
    expect(store.verify(token)?.permittedGuildIds.sort()).toEqual(["a", "b"]);
  });

  test("revoke invalidates a previously valid token", () => {
    const store = new SessionStore();
    const token = store.mint({ identity, permittedGuildIds: ["a"] });
    store.revoke(token);
    expect(store.verify(token)).toBeNull();
  });
});
