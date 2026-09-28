import { describe, expect, test } from "bun:test";
import { AuditLogEvent, type GuildAuditLogsEntry } from "discord.js";
import { actionFor } from "./screening.ts";

function entry(action: AuditLogEvent, changes: { key: string; old?: unknown; new?: unknown }[] = []): GuildAuditLogsEntry {
  return { action, changes } as unknown as GuildAuditLogsEntry;
}

describe("actionFor", () => {
  test("bans, kicks and timeouts count as mod actions", () => {
    expect(actionFor(entry(AuditLogEvent.MemberBanAdd))).toBe("banned");
    expect(actionFor(entry(AuditLogEvent.MemberKick))).toBe("kicked");
    expect(actionFor(entry(AuditLogEvent.MemberUpdate, [{ key: "communication_disabled_until", new: "2026-10-01T00:00:00Z" }]))).toBe("timed out");
  });

  test("removing a timeout, nick changes and other events are ignored", () => {
    expect(actionFor(entry(AuditLogEvent.MemberUpdate, [{ key: "communication_disabled_until", old: "x", new: undefined }]))).toBeNull();
    expect(actionFor(entry(AuditLogEvent.MemberUpdate, [{ key: "nick", new: "bob" }]))).toBeNull();
    expect(actionFor(entry(AuditLogEvent.MessageDelete))).toBeNull();
  });
});
