// Memory bank keying — the single source of truth for which mnemosyne/local banks a turn reads and
// writes. Three buckets, all prefixed `sushii`, so the private (DM) self is walled off from the
// public (in-space) self:
//   - DM / private individual:   sushii-dm-<userId>
//   - per-space individual:      sushii-space-<spaceId>-user-<userId>
//   - space general (the place): sushii-space-<spaceId>
// Recall composes a read SET by context; writes go to the individual bucket. A private DM bank is
// NEVER in a public-space read set (hard wall). One mapping so retrieve and remember can't drift.

export interface MemoryScope {
  spaceId: string;
  userId: string;
  isPrivate: boolean;
  /** When the DM author resolves to a linked principal: the unified DM identity. Present → the
   *  private WRITE bank becomes `sushii-dm-principal-<principalId>` and the private READ set unions
   *  in the legacy per-identity DM banks (this userId + `aliasUserIds`) so existing per-surface DM
   *  memory isn't orphaned. Ignored entirely for public spaces (the hard wall). */
  principalId?: string;
  /** The principal's OTHER identities' userIds — their legacy DM banks, read-aliased into the private
   *  set alongside this userId's. Only consulted when `principalId` is set and the scope is private. */
  aliasUserIds?: string[];
}

export interface MemoryBanks {
  read: string[];
  write: string | null;
}

/** Blank space/user → no access (unscoped → no bank), so a bare/empty id can't hit a shared default
 *  bank. Private → the DM bucket only. Public → the individual bucket first (priority) then the
 *  space-general bucket. */
export function memoryBanks(scope: MemoryScope): MemoryBanks {
  const s = scope.spaceId.trim();
  const u = scope.userId.trim();
  if (s.length === 0 || u.length === 0) return { read: [], write: null };

  if (scope.isPrivate) {
    const pid = scope.principalId?.trim() ?? "";
    if (pid.length > 0) {
      // Read-alias: write to the unified principal bank; read it PLUS every legacy per-identity DM
      // bank so nothing already written per-surface is orphaned. Never hard-switches or migrates.
      const write = `sushii-dm-principal-${pid}`;
      const read = [write, `sushii-dm-${u}`];
      for (const alias of scope.aliasUserIds ?? []) {
        const a = alias.trim();
        if (a.length === 0) continue;
        const bank = `sushii-dm-${a}`;
        if (!read.includes(bank)) read.push(bank);
      }
      return { read, write };
    }
    const dm = `sushii-dm-${u}`;
    return { read: [dm], write: dm };
  }

  // Public read set ignores principal aliasing entirely — a private/DM bank is NEVER reachable here.
  const individual = `sushii-space-${s}-user-${u}`;
  const general = `sushii-space-${s}`;
  return { read: [individual, general], write: individual };
}
