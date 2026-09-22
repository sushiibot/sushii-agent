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
    const dm = `sushii-dm-${u}`;
    return { read: [dm], write: dm };
  }

  const individual = `sushii-space-${s}-user-${u}`;
  const general = `sushii-space-${s}`;
  return { read: [individual, general], write: individual };
}
