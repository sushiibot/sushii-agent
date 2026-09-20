import { describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { computeAuthTag, validateConditions, verifyAuthTag } from "./nipOa.ts";

// Spec test vector lifted verbatim from buzz-sdk/src/nip_oa.rs tests — proves byte-compatibility with
// buzz, not just internal self-consistency. Owner priv = 1, agent pubkey = 2G.
const OWNER_PUBKEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT_PUBKEY = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const CONDITIONS = "kind=1&created_at<1713957000";
const SPEC_SIG = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
const OWNER_SK = new Uint8Array(32);
OWNER_SK[31] = 1;

describe("verifyAuthTag", () => {
  test("accepts buzz's published spec signature", () => {
    expect(verifyAuthTag(["auth", OWNER_PUBKEY, CONDITIONS, SPEC_SIG], AGENT_PUBKEY)).toBe(OWNER_PUBKEY);
  });

  test("rejects the spec tag against a different agent pubkey", () => {
    expect(() => verifyAuthTag(["auth", OWNER_PUBKEY, CONDITIONS, SPEC_SIG], "f".repeat(64))).toThrow();
  });

  test("rejects a tampered signature", () => {
    const bad = SPEC_SIG.slice(0, -1) + (SPEC_SIG.endsWith("9") ? "8" : "9");
    expect(() => verifyAuthTag(["auth", OWNER_PUBKEY, CONDITIONS, bad], AGENT_PUBKEY)).toThrow();
  });

  test("rejects a non-auth label and a wrong element count", () => {
    expect(() => verifyAuthTag(["notauth", OWNER_PUBKEY, CONDITIONS, SPEC_SIG], AGENT_PUBKEY)).toThrow();
    expect(() => verifyAuthTag(["auth", OWNER_PUBKEY, CONDITIONS], AGENT_PUBKEY)).toThrow();
  });
});

describe("computeAuthTag", () => {
  test("derives the spec owner pubkey and round-trips through verify", () => {
    const tag = computeAuthTag(OWNER_SK, AGENT_PUBKEY, CONDITIONS);
    expect(tag[0]).toBe("auth");
    expect(tag[1]).toBe(OWNER_PUBKEY);
    expect(tag[2]).toBe(CONDITIONS);
    expect(verifyAuthTag(tag, AGENT_PUBKEY)).toBe(OWNER_PUBKEY);
  });

  test("defaults to empty conditions and round-trips", () => {
    const agent = bytesToHex(schnorr.getPublicKey(new Uint8Array([2, ...new Array(31).fill(0)])));
    const tag = computeAuthTag(OWNER_SK, agent);
    expect(tag[2]).toBe("");
    expect(verifyAuthTag(tag, agent)).toBe(OWNER_PUBKEY);
  });

  test("rejects self-attestation", () => {
    expect(() => computeAuthTag(OWNER_SK, OWNER_PUBKEY)).toThrow();
  });
});

describe("validateConditions", () => {
  test("accepts empty and valid clauses", () => {
    for (const c of ["", "kind=1", "kind=0", "created_at<1713957000", "kind=9&created_at>100"]) {
      expect(() => validateConditions(c)).not.toThrow();
    }
  });

  test("rejects whitespace, leading zeros, out-of-range, and bad clauses", () => {
    for (const c of ["kind= 1", "kind=01", "kind=70000", "kind=1&", "&kind=1", "foo=1"]) {
      expect(() => validateConditions(c)).toThrow();
    }
  });
});
