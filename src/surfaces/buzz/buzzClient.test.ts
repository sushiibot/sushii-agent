import { describe, expect, test } from "bun:test";
import { CliBuzzClient } from "./buzzClient.ts";

// Fixed keypair (generated offline with `nak key generate`); ownPubkey must derive PUB with no relay.
const SEC = "ce4537386cd678abd684afcd43bcc6ae77220877a312a688ec77b07e6585a76b";
const NSEC = "nsec1eeznwwrv6eu2h45y4lx580xx4emjyzrh5vf2dz8vw7c8uev95a4sdjt3fv";
const PUB = "7060699d8fd0b2c62cd67f7ef8226b55d97f90b302ef0caf4644a648c6815487";

describe("CliBuzzClient.ownPubkey (offline derivation)", () => {
  test("derives the x-only pubkey from a hex secret", async () => {
    expect(await new CliBuzzClient({ privateKey: SEC }).ownPubkey()).toBe(PUB);
  });

  test("derives the same pubkey from the nsec form", async () => {
    expect(await new CliBuzzClient({ privateKey: NSEC }).ownPubkey()).toBe(PUB);
  });

  test("rejects a malformed key", async () => {
    await expect(new CliBuzzClient({ privateKey: "not-a-key" }).ownPubkey()).rejects.toThrow();
  });
});
