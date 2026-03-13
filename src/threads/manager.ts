import type { Message, ThreadChannel } from "discord.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { openai } from "../agent/client.ts";
import { config } from "../config.ts";

export async function resolveOrCreateThread(
  message: Message,
): Promise<{ thread: ThreadChannel; isNew: boolean }> {
  const channel = message.channel;

  if (channel.isThread()) {
    return { thread: channel as ThreadChannel, isNew: false };
  }

  const thread = await message.startThread({
    name: "sushii-agent investigation",
    autoArchiveDuration: 1440, // 24 hours
  });

  return { thread, isNew: true };
}

export async function renameThread(
  thread: ThreadChannel,
  history: ChatCompletionMessageParam[],
): Promise<void> {
  try {
    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        ...history,
        {
          role: "user",
          content:
            "Write a thread title of 8 words or fewer summarizing this investigation. Return only the title, no quotes or punctuation.",
        },
      ],
      max_tokens: 60,
    });

    const title = response.choices[0]?.message.content?.trim();
    if (title) {
      await thread.setName(title.slice(0, 100));
    }
  } catch (err) {
    console.error("Failed to rename thread:", err);
  }
}
