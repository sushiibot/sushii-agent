import { describe, expect, test } from "bun:test";
import type { MessageEditOptions } from "discord.js";
import type { ChatMessageMode, ChatMessageParams } from "../../orchestration/contracts.ts";
import { handleWorkspaceAskButton, handleWorkspaceStopButton, type WorkspaceButtonDeps, type WorkspaceButtonInteraction } from "./workspaceButtons.ts";
import { ACCENT } from "./workspaceAdapter.ts";

const OWNER = "owner-1";

function textOf(options: MessageEditOptions): string {
  return JSON.stringify((options.components ?? []).map((c) => ("toJSON" in c ? c.toJSON() : c)));
}

function fakeInteraction(customId: string, opts: { userId?: string; label?: string } = {}) {
  const replies: unknown[] = [];
  const editReplies: unknown[] = [];
  const messageEdits: MessageEditOptions[] = [];
  let deferred = false;
  const interaction = {
    customId,
    id: `int-${Math.random()}`,
    channelId: "dm-1",
    user: { id: opts.userId ?? OWNER, username: "drk", globalName: "drk" },
    component: { label: opts.label ?? null },
    message: {
      components: [],
      edit: async (o: MessageEditOptions) => {
        messageEdits.push(o);
      },
    },
    reply: async (o: unknown) => {
      replies.push(o);
    },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async (o: unknown) => {
      editReplies.push(o);
    },
  } as unknown as WorkspaceButtonInteraction;
  return { interaction, replies, editReplies, messageEdits, deferred: () => deferred };
}

function fakeLink(opts: { tracked?: string[]; aborted?: boolean; mode?: ChatMessageMode; choices?: Record<string, string[]> } = {}) {
  const calls = { aborts: [] as Array<string | undefined>, messages: [] as Array<Omit<ChatMessageParams, "principalId">>, ended: [] as string[] };
  const link: WorkspaceButtonDeps["link"] = {
    hasTurn: (id) => (opts.tracked ?? []).includes(id),
    abort: async (turnId) => {
      calls.aborts.push(turnId);
      return { aborted: opts.aborted ?? true };
    },
    markTurnEnded: (id) => void calls.ended.push(id),
    askChoice: (askId, i, label) => opts.choices?.[askId]?.[i] ?? label,
    sendMessage: async (input) => {
      calls.messages.push(input);
      return { accepted: true, mode: opts.mode ?? "prompt" };
    },
  };
  return { link, calls };
}

describe("workspace Stop button", () => {
  test("only the owner can stop; nothing is aborted otherwise", async () => {
    const { link, calls } = fakeLink({ tracked: ["t1"] });
    const i = fakeInteraction("wsstop:t1", { userId: "stranger" });
    await handleWorkspaceStopButton(i.interaction, { ownerId: OWNER, link });
    expect(calls.aborts).toHaveLength(0);
    expect(JSON.stringify(i.replies)).toContain("Only the owner");

    const unset = fakeInteraction("wsstop:t1");
    await handleWorkspaceStopButton(unset.interaction, { ownerId: undefined, link });
    expect(calls.aborts).toHaveLength(0);
  });

  test("a live turn: chat/abort carries the button's turnId; the event stream finalizes the message", async () => {
    const { link, calls } = fakeLink({ tracked: ["t1"] });
    const i = fakeInteraction("wsstop:t1");
    await handleWorkspaceStopButton(i.interaction, { ownerId: OWNER, link });
    expect(i.deferred()).toBe(true);
    expect(calls.aborts).toEqual(["t1"]);
    expect(i.messageEdits).toHaveLength(0);
    expect(i.editReplies).toEqual(["Stopping…"]);
  });

  test("a stale progress message from before a restart: the workspace no-ops, and the message is marked interrupted", async () => {
    const { link, calls } = fakeLink({ aborted: false });
    const i = fakeInteraction("wsstop:old-turn");
    await handleWorkspaceStopButton(i.interaction, { ownerId: OWNER, link });
    expect(calls.aborts).toEqual(["old-turn"]);
    expect(calls.ended).toEqual(["old-turn"]);
    expect(i.messageEdits.map(textOf)).toEqual([expect.stringContaining('"content":"⚠️ interrupted"')]);
    expect(i.editReplies).toEqual(["That turn already finished."]);
  });

  test("an untracked turn that was still running is stopped and its message finalized here", async () => {
    const { link, calls } = fakeLink({ aborted: true });
    const i = fakeInteraction("wsstop:t2");
    await handleWorkspaceStopButton(i.interaction, { ownerId: OWNER, link });
    expect(calls.ended).toEqual(["t2"]);
    expect(i.messageEdits.map(textOf)).toEqual([expect.stringContaining('"content":"⏹ stopped"')]);
    expect(i.editReplies).toEqual(["Stopping…"]);
  });
});

describe("workspace ask button", () => {
  test("only the owner can answer", async () => {
    const { link, calls } = fakeLink({ choices: { ask9: ["Yes", "No"] } });
    const i = fakeInteraction("wsask:ask9:0", { userId: "stranger" });
    await handleWorkspaceAskButton(i.interaction, { ownerId: OWNER, link });
    expect(calls.messages).toHaveLength(0);
    expect(JSON.stringify(i.replies)).toContain("Only the owner");
  });

  test("a click sends chat/message keyed by the ask, then strips the buttons", async () => {
    const { link, calls } = fakeLink({ choices: { ask9: ["Yes", "No"] } });
    const i = fakeInteraction("wsask:ask9:1");
    await handleWorkspaceAskButton(i.interaction, { ownerId: OWNER, link });
    expect(calls.messages).toEqual([{ origin: { surface: "discord", conversationId: "dm-1" }, messageId: "wsask:ask9", text: "No", kind: "user", author: { id: OWNER, name: "drk" } }]);
    expect(i.editReplies).toEqual(["Answered: No"]);
    expect(i.messageEdits).toHaveLength(1);
    expect(textOf(i.messageEdits[0]!)).toContain(`"accent_color":${ACCENT.success}`);
  });

  test("a second click of the same ask reuses the message id, so the workspace reports a duplicate", async () => {
    const { link, calls } = fakeLink({ choices: { ask9: ["Yes", "No"] }, mode: "duplicate" });
    const i = fakeInteraction("wsask:ask9:0");
    await handleWorkspaceAskButton(i.interaction, { ownerId: OWNER, link });
    expect(calls.messages[0]!.messageId).toBe("wsask:ask9");
    expect(i.editReplies).toEqual(["Already answered."]);
  });

  test("after a restart the button's label is the answer; with neither, the ask is inactive", async () => {
    const { link, calls } = fakeLink();
    const labelled = fakeInteraction("wsask:ask1:0", { label: "Merge now" });
    await handleWorkspaceAskButton(labelled.interaction, { ownerId: OWNER, link });
    expect(calls.messages[0]!.text).toBe("Merge now");

    const blank = fakeInteraction("wsask:ask2:0");
    await handleWorkspaceAskButton(blank.interaction, { ownerId: OWNER, link });
    expect(calls.messages).toHaveLength(1);
    expect(JSON.stringify(blank.replies)).toContain("no longer active");
  });
});
