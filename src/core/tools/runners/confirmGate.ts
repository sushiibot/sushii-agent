// Confirm-before-dispatch for non-owner principals. A dispatch request is parked here and only
// released by a confirm_token redeemed in a LATER user turn than the one that issued it, so the
// model can't propose-and-confirm on its own — a real human reply has to land in between.
import { randomBytes } from "node:crypto";
import type { RepoSpec } from "../../../orchestration/contracts.ts";

export interface ParkedDispatch {
  principal: string;
  space: string;
  runnerId: string;
  viaPref: boolean;
  cwd: string;
  repo?: RepoSpec;
  project: string | null;
  projectKey: string;
  prompt: string;
}

interface Entry {
  dispatch: ParkedDispatch;
  issuedTurn: string | undefined;
  expiresAt: number;
}

const TTL_MS = 30 * 60_000;
const parked = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [token, entry] of parked) if (entry.expiresAt <= now) parked.delete(token);
}

export function parkDispatch(dispatch: ParkedDispatch, turnId: string | undefined, now = Date.now()): string {
  sweep(now);
  const token = randomBytes(6).toString("hex");
  parked.set(token, { dispatch, issuedTurn: turnId, expiresAt: now + TTL_MS });
  return token;
}

export type RedeemResult = { ok: true; dispatch: ParkedDispatch } | { ok: false; reason: string };

/** Single-use. A same-turn redeem is rejected WITHOUT consuming the token, so the model can still
 *  hand it back after the user actually replies. A missing turnId never matches (fail-closed). */
export function redeemDispatch(token: string, principal: string, space: string, turnId: string | undefined, now = Date.now()): RedeemResult {
  sweep(now);
  const entry = parked.get(token);
  if (!entry || entry.dispatch.principal !== principal || entry.dispatch.space !== space) {
    return { ok: false, reason: "Unknown or expired confirm_token. Call dispatch_to_runner again without it to get a fresh confirmation." };
  }
  if (turnId === undefined || entry.issuedTurn === undefined || entry.issuedTurn === turnId) {
    return { ok: false, reason: "Not dispatched: the user hasn't confirmed yet. Wait for their explicit reply in a new message before using the confirm_token." };
  }
  parked.delete(token);
  return { ok: true, dispatch: entry.dispatch };
}

export function _resetParkedDispatches(): void {
  parked.clear();
}
