import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// NIP-OA owner attestation: an owner keypair signs a tag vouching for an agent pubkey. buzz reads the
// tag off the agent's kind:0 profile to mark it as an owned agent. Byte-for-byte compatible with
// buzz-sdk/src/nip_oa.rs — the preimage string, sha256 hashing, and 4-element tag shape must match or
// the relay/clients reject the signature.

const AUTH_TAG_LABEL = "auth";

/** buzz preimage: `nostr:agent-auth:<agentPubkeyHex>:<conditions>`, then sha256 of its UTF-8 bytes. */
function authDigest(agentPubkeyHex: string, conditions: string): Uint8Array {
  return sha256(utf8ToBytes(`nostr:agent-auth:${agentPubkeyHex}:${conditions}`));
}

/** Mirror of buzz `validate_conditions`: empty ok, else `&`-joined clauses, each `kind=<0-65535>`,
 *  `created_at<<u32>`, or `created_at><u32>`, canonical decimals (no leading zeros, no whitespace). */
export function validateConditions(conditions: string): void {
  if (conditions === "") return;
  if (/\s/.test(conditions)) throw new Error("conditions must not contain whitespace");
  for (const clause of conditions.split("&")) {
    if (clause === "") throw new Error("empty clause in conditions (leading/trailing/double '&')");
    const m = /^(kind=|created_at<|created_at>)(\d+)$/.exec(clause);
    if (!m) throw new Error(`unsupported clause: ${JSON.stringify(clause)}`);
    const [, label, value] = m;
    if (value.length > 1 && value.startsWith("0")) throw new Error(`${label} value has leading zero: ${JSON.stringify(value)}`);
    const max = label === "kind=" ? 65535 : 4294967295;
    if (Number(value) > max) throw new Error(`${label} value ${value} out of range [0, ${max}]`);
  }
}

/** Owner signs an attestation for `agentPubkeyHex`. Returns the 4-element tag `["auth", ownerPubkey,
 *  conditions, sig]`. Rejects self-attestation (owner and agent pubkeys must differ), like buzz. */
export function computeAuthTag(ownerSecretKey: Uint8Array, agentPubkeyHex: string, conditions = ""): string[] {
  const ownerPubkeyHex = bytesToHex(schnorr.getPublicKey(ownerSecretKey));
  if (ownerPubkeyHex === agentPubkeyHex) throw new Error("owner and agent pubkeys must differ (self-attestation rejected)");
  validateConditions(conditions);
  const sig = bytesToHex(schnorr.sign(authDigest(agentPubkeyHex, conditions), ownerSecretKey));
  return [AUTH_TAG_LABEL, ownerPubkeyHex, conditions, sig];
}

/** Verify a NIP-OA tag against `agentPubkeyHex`. Returns the owner pubkey on success, throws otherwise.
 *  Signature-only, like buzz's profile display path — conditions are validated for shape, not enforced. */
export function verifyAuthTag(tag: string[], agentPubkeyHex: string): string {
  if (tag.length !== 4) throw new Error(`auth tag must have 4 elements, got ${tag.length}`);
  const [label, ownerPubkeyHex, conditions, sigHex] = tag;
  if (label !== AUTH_TAG_LABEL) throw new Error(`first element must be "auth", got ${JSON.stringify(label)}`);
  if (!/^[0-9a-f]{64}$/.test(ownerPubkeyHex)) throw new Error("owner pubkey must be 64 lowercase hex chars");
  if (!/^[0-9a-f]{128}$/.test(sigHex)) throw new Error("signature must be 128 lowercase hex chars");
  validateConditions(conditions);
  if (ownerPubkeyHex === agentPubkeyHex) throw new Error("owner and agent pubkeys must differ (self-attestation rejected)");
  if (!schnorr.verify(hexToBytes(sigHex), authDigest(agentPubkeyHex, conditions), hexToBytes(ownerPubkeyHex))) {
    throw new Error("signature verification failed");
  }
  return ownerPubkeyHex;
}
