import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { RPC_METHODS, type ChatMessageMode, type ChatMessageParams } from "../../orchestration/contracts.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import { SurfaceRegistry } from "../../orchestration/workspace/surface.ts";
import { handleWorkspaceAskButton, handleWorkspaceStopButton, type WorkspaceButtonInteraction } from "./workspaceButtons.ts";
import { ACCENT, DiscordWorkspaceAdapter, type DmChannelPort } from "./workspaceAdapter.ts";

const OWNER = "owner-1";
const P = "drk";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "streaming" };

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

type Calls = { aborts: Array<string | undefined>; messages: Array<Omit<ChatMessageParams, "principalId">> };

/** A real WorkspaceLink over a fake workspace connection, so the core's stop/ask logic is what's tested. */
async function fakeLink(opts: { tracked?: string[]; aborted?: boolean | Error; mode?: ChatMessageMode; choices?: Record<string, string[]>; owner?: string | null } = {}) {
  const owner = opts.owner === undefined ? OWNER : opts.owner;
  const calls: Calls = { aborts: [], messages: [] };
  const sent: MessageCreateOptions[] = [];
  const channel: DmChannelPort = { send: async (o) => (sent.push(o), { id: `m${sent.length}`, edit: async () => {} }) };
  const db = new Database(":memory:");
  applySchema(db);
  const link = new WorkspaceLink({
    principalId: P,
    store: new WorkspaceLinkStore(db),
    surfaces: new SurfaceRegistry("discord").register(new DiscordWorkspaceAdapter({ ownerChannel: async () => channel })),
    owner: () => ({ id: owner ?? "", name: "drk" }),
    isOwner: (a) => owner !== null && a.surface === "discord" && a.userId === owner,
  });
  link.attach({
    getWorkspaceConnection: () => CONN,
    setWorkspaceHandler: () => {},
    requestWorkspace: async (_p, method, params) => {
      if (method === RPC_METHODS.chatAbort) {
        calls.aborts.push((params as { turnId?: string }).turnId);
        if (opts.aborted instanceof Error) throw opts.aborted;
        return { aborted: opts.aborted ?? true };
      }
      if (method === RPC_METHODS.chatMessage) {
        const { principalId: _, ...input } = params as ChatMessageParams;
        calls.messages.push(input);
        return { accepted: true, mode: opts.mode ?? "prompt" };
      }
      return {};
    },
  });
  for (const turnId of opts.tracked ?? []) link.onEvent({ principalId: P, turnId, agentId: "main", ev: { type: "turn_start" } });
  for (const [askId, choices] of Object.entries(opts.choices ?? {})) {
    await link.deliver({ outboxId: `o-${askId}`, principalId: P, kind: "ask", text: "?", ask: { askId, question: "?", choices } });
  }
  sent.length = 0;
  /** Whether an aborted turn_end for `turnId` would still post a "stopped" message (it was never marked ended). */
  const postsStopped = async (turnId: string) => {
    link.onEvent({ principalId: P, turnId, agentId: "main", ev: { type: "turn_end", aborted: true } });
    await new Promise((r) => setTimeout(r, 0));
    return sent.length > 0;
  };
  return { link, calls, postsStopped };
}

describe("workspace Stop button", () => {
  test("only the owner can stop; nothing is aborted otherwise", async () => {
    const { link, calls } = await fakeLink({ tracked: ["t1"] });
    const i = fakeInteraction("wsstop:t1", { userId: "stranger" });
    await handleWorkspaceStopButton(i.interaction, { link });
    expect(calls.aborts).toHaveLength(0);
    expect(JSON.stringify(i.replies)).toContain("Only the owner");
    expect(i.deferred()).toBe(false);

    const unsetLink = await fakeLink({ tracked: ["t1"], owner: null });
    const unset = fakeInteraction("wsstop:t1");
    await handleWorkspaceStopButton(unset.interaction, { link: unsetLink.link });
    expect(unsetLink.calls.aborts).toHaveLength(0);
    expect(JSON.stringify(unset.replies)).toContain("Only the owner");
  });

  test("a live turn: chat/abort carries the button's turnId; the event stream finalizes the message", async () => {
    const { link, calls } = await fakeLink({ tracked: ["t1"] });
    const i = fakeInteraction("wsstop:t1");
    await handleWorkspaceStopButton(i.interaction, { link });
    expect(i.deferred()).toBe(true);
    expect(calls.aborts).toEqual(["t1"]);
    expect(i.messageEdits).toHaveLength(0);
    expect(i.editReplies).toEqual(["Stopping…"]);
  });

  test("a stale progress message from before a restart: the workspace no-ops, and the message is marked interrupted", async () => {
    const { link, calls, postsStopped } = await fakeLink({ aborted: false });
    const i = fakeInteraction("wsstop:old-turn");
    await handleWorkspaceStopButton(i.interaction, { link });
    expect(calls.aborts).toEqual(["old-turn"]);
    expect(await postsStopped("old-turn")).toBe(false);
    expect(i.messageEdits.map(textOf)).toEqual([expect.stringContaining('"content":"⚠️ interrupted"')]);
    expect(i.editReplies).toEqual(["That turn already finished."]);
  });

  test("an untracked turn that was still running is stopped and its message finalized here", async () => {
    const { link, postsStopped } = await fakeLink({ aborted: true });
    const i = fakeInteraction("wsstop:t2");
    await handleWorkspaceStopButton(i.interaction, { link });
    expect(await postsStopped("t2")).toBe(false);
    expect(i.messageEdits.map(textOf)).toEqual([expect.stringContaining('"content":"⏹ stopped"')]);
    expect(i.editReplies).toEqual(["Stopping…"]);
  });

  test("a failed abort is reported and the message left alone", async () => {
    const { link } = await fakeLink({ aborted: new Error("socket gone") });
    const i = fakeInteraction("wsstop:t3");
    await handleWorkspaceStopButton(i.interaction, { link });
    expect(i.deferred()).toBe(true);
    expect(i.editReplies).toEqual(["Couldn't stop: socket gone"]);
    expect(i.messageEdits).toHaveLength(0);
  });
});

describe("workspace ask button", () => {
  test("only the owner can answer", async () => {
    const { link, calls } = await fakeLink({ choices: { ask9: ["Yes", "No"] } });
    const i = fakeInteraction("wsask:ask9:0", { userId: "stranger" });
    await handleWorkspaceAskButton(i.interaction, { link });
    expect(calls.messages).toHaveLength(0);
    expect(JSON.stringify(i.replies)).toContain("Only the owner");
    expect(i.deferred()).toBe(false);
  });

  test("a click sends chat/message keyed by the ask, then strips the buttons", async () => {
    const { link, calls } = await fakeLink({ choices: { ask9: ["Yes", "No"] } });
    const i = fakeInteraction("wsask:ask9:1");
    await handleWorkspaceAskButton(i.interaction, { link });
    expect(calls.messages).toEqual([{ origin: { surface: "discord", conversationId: "dm-1" }, messageId: "wsask:ask9", text: "No", kind: "user", author: { id: OWNER, name: "drk" }, fileUploads: true }]);
    expect(i.editReplies).toEqual(["Answered: No"]);
    expect(i.messageEdits).toHaveLength(1);
    expect(textOf(i.messageEdits[0]!)).toContain(`"accent_color":${ACCENT.success}`);
  });

  test("a second click of the same ask reuses the message id, so the workspace reports a duplicate", async () => {
    const { link, calls } = await fakeLink({ choices: { ask9: ["Yes", "No"] }, mode: "duplicate" });
    const i = fakeInteraction("wsask:ask9:0");
    await handleWorkspaceAskButton(i.interaction, { link });
    expect(calls.messages[0]!.messageId).toBe("wsask:ask9");
    expect(i.editReplies).toEqual(["Already answered."]);
  });

  test("after a restart the button's label is the answer; with neither, the ask is inactive", async () => {
    const { link, calls } = await fakeLink();
    const labelled = fakeInteraction("wsask:ask1:0", { label: "Merge now" });
    await handleWorkspaceAskButton(labelled.interaction, { link });
    expect(calls.messages[0]!.text).toBe("Merge now");

    const blank = fakeInteraction("wsask:ask2:0");
    await handleWorkspaceAskButton(blank.interaction, { link });
    expect(calls.messages).toHaveLength(1);
    expect(JSON.stringify(blank.replies)).toContain("no longer active");
    expect(blank.deferred()).toBe(false);
  });
});
