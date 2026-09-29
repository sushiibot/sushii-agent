import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { ChatOrigin } from "../../orchestration/contracts.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";
import type { WorkspaceTools } from "../../orchestration/workspace/tools.ts";
import { getLogger } from "../../logger.ts";
import { DISCORD_SURFACE, WS_ASK_PREFIX, WS_STOP_PREFIX, answeredAsk, parseApprovalId, renderProgressFinal } from "./workspaceAdapter.ts";

const log = getLogger("surfaces/discord/workspaceButtons");

/** The ButtonInteraction surface these handlers use; tests pass a fake. */
export type WorkspaceButtonInteraction = Pick<
  ButtonInteraction,
  "customId" | "id" | "channelId" | "user" | "component" | "message" | "reply" | "deferReply" | "editReply" | "deferUpdate"
>;

export interface WorkspaceButtonDeps {
  link: Pick<WorkspaceLink, "stopTurn" | "answerAsk">;
}

function actorOf(interaction: WorkspaceButtonInteraction): SurfaceActor {
  return { surface: DISCORD_SURFACE, userId: interaction.user.id, name: interaction.user.globalName ?? interaction.user.username };
}

function originOf(interaction: WorkspaceButtonInteraction): ChatOrigin {
  return { surface: DISCORD_SURFACE, conversationId: interaction.channelId };
}

// abort and chat/message can outlast Discord's 3 s interaction deadline.
function deferEphemeral(interaction: WorkspaceButtonInteraction): () => Promise<unknown> {
  return () => interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
}

/** Stop on a progress message. */
export async function handleWorkspaceStopButton(interaction: WorkspaceButtonInteraction, deps: WorkspaceButtonDeps): Promise<void> {
  const turnId = interaction.customId.slice(WS_STOP_PREFIX.length);
  const res = await deps.link.stopTurn(originOf(interaction), turnId, actorOf(interaction), { onAccepted: deferEphemeral(interaction) });
  if (res.status === "forbidden") {
    await interaction.reply({ content: "Only the owner can stop this.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (res.status === "failed") {
    await interaction.editReply(`Couldn't stop: ${res.error}`).catch(() => {});
    return;
  }
  if (res.final) {
    await interaction.message
      .edit(renderProgressFinal(res.final))
      .catch((err) => log.warn({ err, turnId }, "failed to finalize an untracked progress message"));
  }
  await interaction.editReply(res.aborted ? "Stopping…" : "That turn already finished.").catch(() => {});
}

export async function handleWorkspaceAskButton(interaction: WorkspaceButtonInteraction, deps: WorkspaceButtonDeps): Promise<void> {
  const [askId, idx] = interaction.customId.slice(WS_ASK_PREFIX.length).split(":");
  const label = "label" in interaction.component ? interaction.component.label : null;
  const res = await deps.link.answerAsk(originOf(interaction), askId ?? "", { index: Number(idx), label: label ?? null }, actorOf(interaction), {
    onAccepted: deferEphemeral(interaction),
  });
  switch (res.status) {
    case "forbidden":
      await interaction.reply({ content: "Only the owner can answer this.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    case "inactive":
      await interaction.reply({ content: "This question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    case "failed":
      await interaction.editReply(`Couldn't deliver the answer: ${res.error}`).catch(() => {});
      return;
    case "duplicate":
      await interaction.editReply("Already answered.").catch(() => {});
      return;
    case "answered":
      await interaction.editReply(`Answered: ${res.answer}`).catch(() => {});
      await interaction.message.edit(answeredAsk(interaction.message, res.answer)).catch(() => {});
      return;
  }
}

/** Approve/Deny on a tool approval prompt. The pending tool/call edits the prompt itself once decided. */
export async function handleWorkspaceApprovalButton(interaction: WorkspaceButtonInteraction, deps: { tools: Pick<WorkspaceTools, "isOwner" | "decide"> }): Promise<void> {
  const actor = actorOf(interaction);
  // Checked before parsing, so a stranger learns nothing about the id; decide() checks again.
  if (!deps.tools.isOwner(actor)) {
    await interaction.reply({ content: "Only the owner can approve this.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const parsed = parseApprovalId(interaction.customId);
  if (!parsed || deps.tools.decide(parsed.nonce, parsed.decision, actor) !== "decided") {
    await interaction.reply({ content: "This approval has expired.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.deferUpdate().catch(() => {});
}
