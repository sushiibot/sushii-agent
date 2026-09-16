// Host member declarations, added to the frozen marker interfaces (contracts.ts §7) via module
// augmentation. `ctx.discord` etc. would otherwise type as the bare `{ readonly _discord: unique
// symbol }` marker — augmenting is the only way to give it real members without editing the
// frozen file. Concrete implementations belong to the surface (U4 for Discord); this module only
// pins the shape each tool entry is written against.
//
// All types are neutral (strings, numbers, plain objects) — no discord.js in signatures.

// Inlined rather than imported from src/tools/listAutomodRules.ts — that file pulls in
// discord-api-types transitively, which would leak a discord.js-adjacent import into core.
export interface AutomodActionInfo {
  type: "block_message" | "send_alert_message" | "timeout" | "block_member_interaction" | "unknown";
  channelId?: string;
  durationSeconds?: number;
  customMessage?: string;
}

export interface DiscordMessageResult {
  discordId: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  content: string;
  replyToId: string | null;
  createdAt: number;
  editedAt: number | null;
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
  topic?: string;
  categoryId?: string;
  categoryName?: string;
}

export interface DiscordChannelDetail extends DiscordChannelInfo {
  parentChannelId?: string;
  parentChannelName?: string;
}

export interface DiscordRoleInfo {
  id: string;
  name: string;
  position: number;
  color?: string;
  isAdmin: boolean;
  isModerator: boolean;
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  memberCount: number;
  verificationLevel: string;
  boostTier: number;
  boostCount: number;
  description?: string;
  preferredLocale: string;
  features: string[];
}

export interface DiscordMemberInfo {
  userId: string;
  username?: string;
  displayName?: string;
  joinedAt?: number | null;
  roles?: { id: string; name: string }[];
  isStillInServer: boolean;
  avatarUrl?: string;
}

export interface DiscordAuditLogEntry {
  createdAt: number;
  action: string;
  executorId: string | null;
  executorUsername: string | null;
  targetId: string | null;
  reason: string | null;
  changes: { key: string; old: unknown; new: unknown }[];
}

export interface DiscordAutomodRuleInfo {
  id: string;
  name: string;
  triggerType: string;
  enabled: boolean;
  keywordFilter: string[];
  regexPatterns: string[];
  allowList: string[];
  actions: AutomodActionInfo[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
}

export interface DiscordPendingAutomodEdit {
  ruleId: string;
  ruleName: string;
  keyword: string;
  newKeywordFilter: string[];
  regexPatterns: string[];
  allowList: string[];
}

export interface DiscordTimeoutResult {
  userId: string;
  durationMs: number;
  expiresAt: number;
  dryRun?: boolean;
}

export interface DiscordDeleteMessagesResult {
  requested: number;
  bulkDeleted: number;
  sequentialDeleted: number;
  errors: number;
  deleted: { id: string; content: string }[];
  dryRun?: boolean;
}

export interface DiscordSendAlertResult {
  messageId: string;
}

/** Guild-scoped moderation settings, resolved by the surface from guild-config.json. */
export interface DiscordModerationConfig {
  modImmuneRoleIds: string[];
  alertsChannelId?: string;
  modRoleId?: string;
  autoModDryRun?: boolean;
}

/** Threading fields for an auto-mod-triggered alert; absent for a manually-invoked run.
 *  U0's AutoModTrigger (contracts.ts §2) doesn't carry these — see registry.ts deviation note. */
export interface DiscordAutoModAnchor {
  anchorMessageId?: string;
  incidentChannelId?: string;
  triggerMessageId?: string;
}

export interface DiscordImageSource {
  channelId: string;
  messageId: string;
}

declare module "../contracts.ts" {
  interface DiscordToolHost {
    fetchChannelMessages(args: {
      channelId: string;
      messageId?: string;
      before?: string;
      after?: string;
      around?: string;
      limit?: number;
    }): Promise<DiscordMessageResult[] | { error: string }>;

    searchGuildMessages(args: {
      content?: string;
      authorId?: string;
      channelId?: string;
      has?: string;
      limit?: number;
      offset?: number;
      sortBy?: "timestamp" | "relevance";
      sortOrder?: "asc" | "desc";
    }): Promise<{ messages: DiscordMessageResult[]; totalResults: number } | { error: string }>;

    listGuildChannels(): Promise<DiscordChannelInfo[] | { error: string }>;
    getChannelInfo(channelId: string): Promise<DiscordChannelDetail | { error: string }>;
    listGuildRoles(): Promise<DiscordRoleInfo[] | { error: string }>;
    getGuildInfo(): Promise<DiscordGuildInfo | { error: string }>;
    getCurrentMemberInfo(userId: string): Promise<DiscordMemberInfo>;

    searchAuditLog(args: {
      actionType?: string;
      executorId?: string;
      targetId?: string;
      limit?: number;
    }): Promise<DiscordAuditLogEntry[]>;

    listAutomodRules(): Promise<DiscordAutomodRuleInfo[] | { error: string }>;
    addAutomodKeyword(args: { ruleId: string; keyword: string }): Promise<DiscordPendingAutomodEdit | { error: string }>;
    deleteAutomodKeyword(args: { ruleId: string; keyword: string }): Promise<DiscordPendingAutomodEdit | { error: string }>;

    getModerationConfig(): DiscordModerationConfig | null;

    timeoutMember(args: {
      userId: string;
      durationMs: number;
      reason?: string;
      modImmuneRoleIds: string[];
      dryRun?: boolean;
    }): Promise<DiscordTimeoutResult | { error: string }>;

    /** `candidates` are pre-selected message IDs (from MessageCacheHost.findDeletableMessages) with
     *  their content, for reporting; the host performs the bulk/sequential split and deletion. */
    deleteMemberMessages(args: {
      channelId: string;
      candidates: { id: string; content: string; createdAt: number }[];
      dryRun?: boolean;
    }): Promise<DiscordDeleteMessagesResult | { error: string }>;

    sendAlertMessage(args: {
      findings: string;
      action: string;
      alertsChannelId: string;
      modRoleId: string;
      dryRun?: boolean;
      anchor?: DiscordAutoModAnchor;
    }): Promise<DiscordSendAlertResult | { error: string }>;

    /** Re-fetches the message live (bypassing cache) and returns its current image attachment/component URLs. */
    fetchMessageImageUrls(source: DiscordImageSource): Promise<string[] | { error: string }>;
  }

  interface MessageCacheHost {
    searchMessages(args: {
      query?: string;
      userIds?: string[];
      channelId?: string;
      since?: number;
      until?: number;
      limit?: number;
      isAutomod?: boolean;
      includeBots?: boolean;
    }): DiscordMessageResult[] | { error: string };

    getConversationContext(args: { messageId: string; window?: number }): DiscordMessageResult[] | { error: string };

    getUserProfile(userId: string): {
      summary: { first_seen: number | null; last_seen: number | null; total_messages: number; channel_count: number } | null;
      channelDistribution: { channel_id: string; count: number }[];
      dailyActivity: { day: string; count: number }[];
    };

    getRecentActivity(args: { userId: string; days?: number; limit?: number }): DiscordMessageResult[];

    resolveUsersByName(args: { name: string; days?: number; limit?: number }): {
      author_id: string;
      author_username: string | null;
      author_display_name: string | null;
      last_active: number;
      message_count: number;
    }[];

    /** For `delete_user_messages`, which selects candidates from the cache before deleting live. */
    findDeletableMessages(args: { userId: string; channelId: string; limit: number }): { discord_id: string; content: string; created_at: number }[];
  }

  interface SushiMcpHost {
    getUserModHistory(args: { userId: string; limit?: number; beforeCaseId?: string }): Promise<
      { caseId: string; action: string; userId: string; userTag: string; actionTime: number; executorId?: string; reason?: string }[]
    >;
    getUserCrossServerBans(userId: string): Promise<
      { guildId: string; guildName?: string; guildMembers: number; lookupDetailsOptIn: boolean; actionTime?: number; reason?: string }[]
    >;
    getGuildRecentCases(limit?: number): Promise<
      { caseId: string; action: string; userId: string; userTag: string; actionTime: number; executorId?: string; reason?: string }[]
    >;
  }
}

// Re-export so consumers only need to import from this module for both the augmented types
// (side-effect import below) and the plain helper types above.
export type {};
