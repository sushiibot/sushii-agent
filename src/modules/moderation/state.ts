import type { TriggeringUser, ChannelContext, UserNames } from "../../agent/loop.ts";
import type { PendingAutomodApproval, PendingAutomodDeletion } from "./executor.ts";

export interface PendingScanState {
  threadId: string;
  guildId: string;
  query: string;
  threadContext: string;
  triggeringUser: TriggeringUser | undefined;
  currentChannel: ChannelContext | undefined;
  mentionedUsers?: Map<string, UserNames>;
}

// Per-guild pending scan approval state (cleared on approval or skip)
export const pendingScans = new Map<string, PendingScanState>();

export interface PendingAutomodApprovalState extends PendingAutomodApproval {
  triggeredByUserId: string;
}

// Per-thread pending automod keyword approval state (in-memory only, cleared on approve/reject/restart)
export const pendingAutomodApprovals = new Map<string, PendingAutomodApprovalState>();

export interface PendingAutomodDeletionState extends PendingAutomodDeletion {
  triggeredByUserId: string;
}

// Per-thread pending automod keyword deletion state (in-memory only, cleared on approve/reject/restart)
export const pendingAutomodDeletions = new Map<string, PendingAutomodDeletionState>();

// Last auto-mod trigger time per "guildId:channelId", to collapse repeated pings for the same incident
export const autoModCooldowns = new Map<string, number>();
