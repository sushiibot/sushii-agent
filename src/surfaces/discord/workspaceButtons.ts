import { MessageFlags, type ButtonInteraction } from "discord.js";
import { getLogger } from "../../logger.ts";
import { WS_ASK_PREFIX, WS_STOP_PREFIX, answeredAsk, type WorkspaceLink } from "./workspaceLink.ts";

const log = getLogger("surfaces/discord/workspaceButtons");

/** The ButtonInteraction surface these handlers use; tests pass a fake. */
export type WorkspaceButtonInteraction = Pick<ButtonInteraction, "customId" | "id" | "user" | "component" | "message" | "reply" | "deferReply" | "editReply">;

export interface WorkspaceButtonDeps {
  ownerId: string | undefined;
  link: Pick<WorkspaceLink, "abort" | "hasTurn" | "markTurnEnded" | "renderFinal" | "askChoice" | "sendMessage">;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stop on a progress message: aborts only that message's turn. A progress message whose turn this process
 *  no longer tracks (it outlived a restart) is finalized here, since no event will reach it. */
export async function handleWorkspaceStopButton(interaction: WorkspaceButtonInteraction, deps: WorkspaceButtonDeps): Promise<void> {
  if (!deps.ownerId || interaction.user.id !== deps.ownerId) {
    await interaction.reply({ content: "Only the owner can stop this.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const turnId = interaction.customId.slice(WS_STOP_PREFIX.length);
  // abort waits for the run to unwind, which can outlast Discord's 3 s interaction deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const tracked = deps.link.hasTurn(turnId);
  let aborted: boolean;
  try {
    aborted = (await deps.link.abort(turnId)).aborted;
  } catch (err) {
    await interaction.editReply(`Couldn't stop: ${errorText(err)}`).catch(() => {});
    return;
  }
  if (!tracked) {
    deps.link.markTurnEnded(turnId);
    await interaction.message
      .edit(deps.link.renderFinal(null, aborted ? "stopped" : "interrupted"))
      .catch((err) => log.warn({ err, turnId }, "failed to finalize an untracked progress message"));
  }
  await interaction.editReply(aborted ? "Stopping…" : "That turn already finished.").catch(() => {});
}

export async function handleWorkspaceAskButton(interaction: WorkspaceButtonInteraction, deps: WorkspaceButtonDeps): Promise<void> {
  if (!deps.ownerId || interaction.user.id !== deps.ownerId) {
    await interaction.reply({ content: "Only the owner can answer this.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const [askId, idx] = interaction.customId.slice(WS_ASK_PREFIX.length).split(":");
  const label = "label" in interaction.component ? interaction.component.label : null;
  const answer = askId ? deps.link.askChoice(askId, Number(idx), label ?? null) : null;
  if (!askId || !answer) {
    await interaction.reply({ content: "This question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  try {
    // Keyed by the ask, so a second click before the buttons are stripped is a workspace-side duplicate.
    const res = await deps.link.sendMessage({
      messageId: `wsask:${askId}`,
      text: answer,
      kind: "user",
      author: { id: interaction.user.id, name: interaction.user.globalName ?? interaction.user.username },
    });
    await interaction.editReply(res.mode === "duplicate" ? "Already answered." : `Answered: ${answer}`).catch(() => {});
    if (res.mode !== "duplicate") await interaction.message.edit(answeredAsk(interaction.message, answer)).catch(() => {});
  } catch (err) {
    await interaction.editReply(`Couldn't deliver the answer: ${errorText(err)}`).catch(() => {});
  }
}
