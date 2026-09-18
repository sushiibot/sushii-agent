import { describe, expect, test } from "bun:test";
import { NostrBuzzClient } from "./buzzClient.ts";
import { toWsUrl } from "./nostrClient.ts";

// Fixed keypair (generated offline with `nak key generate`); ownPubkey must derive PUB with no relay.
const SEC = "ce4537386cd678abd684afcd43bcc6ae77220877a312a688ec77b07e6585a76b";
const NSEC = "nsec1eeznwwrv6eu2h45y4lx580xx4emjyzrh5vf2dz8vw7c8uev95a4sdjt3fv";
const PUB = "7060699d8fd0b2c62cd67f7ef8226b55d97f90b302ef0caf4644a648c6815487";

describe("NostrBuzzClient.ownPubkey (offline derivation)", () => {
  test("derives the x-only pubkey from a hex secret", async () => {
    expect(await new NostrBuzzClient({ privateKey: SEC }).ownPubkey()).toBe(PUB);
  });

  test("derives the same pubkey from the nsec form", async () => {
    expect(await new NostrBuzzClient({ privateKey: NSEC }).ownPubkey()).toBe(PUB);
  });

  test("rejects a malformed key at construction", () => {
    expect(() => new NostrBuzzClient({ privateKey: "not-a-key" })).toThrow();
  });
});

describe("toWsUrl", () => {
  test("https → wss and strips trailing slash", () => {
    expect(toWsUrl("https://buzz.example/")).toBe("wss://buzz.example");
  });
  test("http → ws", () => {
    expect(toWsUrl("http://localhost:3000")).toBe("ws://localhost:3000");
  });
  test("leaves an already-ws url alone", () => {
    expect(toWsUrl("wss://buzz.example")).toBe("wss://buzz.example");
  });
});
