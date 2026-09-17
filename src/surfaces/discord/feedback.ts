import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConversationStore } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { saveFeedback } from "../../feedback.ts";
import { FEEDBACK_BTN_PREFIX, FEEDBACK_MODAL_PREFIX } from "./buttonIds.ts";

const logger = getLogger("surfaces/discord/feedback");

/** Button handler for fb:{threadId}:{up|down} — opens the feedback modal. */
export async function handleFeedbackButton(interaction: ButtonInteraction): Promise<void> {
  const rest = interaction.customId.slice(FEEDBACK_BTN_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return;
  const threadId = rest.slice(0, lastColon);
  const sentiment = rest.slice(lastColon + 1); // "up" | "down"

  const modal = new ModalBuilder()
    .setCustomId(`${FEEDBACK_MODAL_PREFIX}${threadId}:${sentiment}`)
    .setTitle(sentiment === "up" ? "What was helpful?" : "What could be improved?");

  const textInput = new TextInputBuilder()
    .setCustomId("fb_text")
    .setLabel("Your feedback (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
  await interaction.showModal(modal);
}

/** Modal submit handler for fbm:{threadId}:{sentiment} — saves the feedback file. */
export async function handleFeedbackModal(interaction: ModalSubmitInteraction, store: ConversationStore): Promise<void> {
  const rest = interaction.customId.slice(FEEDBACK_MODAL_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length < 2) return;
  const [threadId, sentiment] = parts;

  const feedbackText = interaction.fields.getTextInputValue("fb_text") ?? "";
  await interaction.reply({ content: "Thanks for the feedback!", flags: MessageFlags.Ephemeral });

  try {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const { messages: conversation } = store.load({ surface: "discord", spaceId: guildId, conversationId: threadId });

    saveFeedback({
      threadId,
      guildId,
      userId: interaction.user.id,
      username: interaction.user.username,
      sentiment: sentiment === "up" ? "positive" : "negative",
      feedback: feedbackText,
      timestamp: new Date().toISOString(),
      conversation,
    });
  } catch (err) {
    logger.error({ err }, "Error saving feedback");
  }
}
