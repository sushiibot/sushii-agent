// Generate a NIP-OA owner-attestation tag for the buzz surface.
//
// The owner (a human keypair the relay already admits) signs a tag vouching for the agent's pubkey.
// Publishing that tag on the agent's kind:0 profile is what makes buzz clients render it as an owned
// agent instead of a plain user. Run this once per agent key; paste the output into BUZZ_AUTH_TAG
// (and the ansible vault as vault_sushii_agent_buzz_auth_tag).
//
// Usage:
//   BUZZ_OWNER_PRIVATE_KEY=<nsec|hex> bun run scripts/generate-buzz-auth-tag.ts [options]
//
//   Agent pubkey (pick one):
//     --agent-pubkey <64-hex>   the agent's x-only pubkey directly
//     (default)                 derived from BUZZ_PRIVATE_KEY in the environment
//
//   --conditions <str>          optional NIP-OA conditions (default: none). e.g. "kind=9"
//
// The owner key is read from BUZZ_OWNER_PRIVATE_KEY, never argv, so it stays out of shell history.
//
// Verify an existing tag against the current agent key (no owner key needed):
//   BUZZ_AUTH_TAG='["auth",...]' BUZZ_PRIVATE_KEY=<nsec|hex> bun run scripts/generate-buzz-auth-tag.ts --verify

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as nip19 from "nostr-tools/nip19";
import { computeAuthTag, verifyAuthTag } from "../src/surfaces/buzz/nipOa.ts";

function decodeSecretKey(raw: string, envName: string): Uint8Array {
  const key = raw.trim();
  if (key.startsWith("nsec")) {
    const decoded = nip19.decode(key);
    if (decoded.type !== "nsec") throw new Error(`${envName} is not a valid nsec`);
    return decoded.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Uint8Array.from(Buffer.from(key, "hex"));
  throw new Error(`${envName} must be 64-char hex or an nsec`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function deriveAgentPubkey(): string {
  const explicit = arg("--agent-pubkey");
  if (explicit) {
    if (!/^[0-9a-f]{64}$/.test(explicit)) fail("agent pubkey must be 64 lowercase hex chars");
    return explicit;
  }
  const agentRaw = process.env["BUZZ_PRIVATE_KEY"];
  if (!agentRaw) fail("pass --agent-pubkey <hex>, or set BUZZ_PRIVATE_KEY to derive it");
  return bytesToHex(schnorr.getPublicKey(decodeSecretKey(agentRaw, "BUZZ_PRIVATE_KEY")));
}

if (process.argv.includes("--verify")) {
  const raw = process.env["BUZZ_AUTH_TAG"];
  if (!raw) fail("set BUZZ_AUTH_TAG to the tag JSON to verify");
  const agentPubkey = deriveAgentPubkey();
  try {
    const owner = verifyAuthTag(JSON.parse(raw) as string[], agentPubkey);
    console.error(`agent pubkey:  ${agentPubkey}`);
    console.error(`owner pubkey:  ${owner}`);
    console.error("OK — tag verifies against this agent key; it will show as an owned agent.");
    process.exit(0);
  } catch (err) {
    fail(`tag does NOT verify against this agent key: ${(err as Error).message}`);
  }
}

const ownerRaw = process.env["BUZZ_OWNER_PRIVATE_KEY"];
if (!ownerRaw) fail("set BUZZ_OWNER_PRIVATE_KEY (the owner's nsec or hex) in the environment");
const ownerSk = decodeSecretKey(ownerRaw, "BUZZ_OWNER_PRIVATE_KEY");

const agentPubkey = deriveAgentPubkey();
const conditions = arg("--conditions") ?? "";

const tag = computeAuthTag(ownerSk, agentPubkey, conditions);
const ownerPubkey = verifyAuthTag(tag, agentPubkey); // self-check: never emit a tag that won't verify

console.error(`agent pubkey:  ${agentPubkey}`);
console.error(`owner pubkey:  ${ownerPubkey}`);
console.error(`conditions:    ${conditions === "" ? "(none)" : conditions}`);
console.error("");
console.error("BUZZ_AUTH_TAG (paste as-is):");
console.log(JSON.stringify(tag)); // env var holds the JSON array string; buzzClient JSON.parses it
