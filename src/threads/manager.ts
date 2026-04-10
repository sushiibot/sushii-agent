import type { Message, ThreadChannel } from "discord.js";
import type { ModelMessage } from "ai";
import { generateText } from "ai";
import { openaiProvider } from "../agent/client.ts";
import { config } from "../config.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("threads");

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
  history: ModelMessage[],
): Promise<void> {
  try {
    const textHistory = history
      .filter((m) => {
        if (m.role === "user") return typeof m.content === "string";
        if (m.role === "assistant") return typeof m.content === "string" && (m.content as string).trim().length > 0;
        return false;
      })
      .slice(-6)
      .map((m) => ({ ...m, content: (m.content as string).slice(0, 500) })) as ModelMessage[];

    const result = await generateText({
      model: openaiProvider(config.openaiModel),
      messages: [
        ...textHistory,
        {
          role: "user",
          content:
            "Write a thread title of 8 words or fewer summarizing this investigation. Return only the title, no quotes or punctuation.",
        },
      ],
      maxOutputTokens: 60,
    });

    const title = result.text.trim();
    if (title) {
      await thread.setName(title.slice(0, 100));
    }
  } catch (err) {
    logger.error({ err }, "Failed to rename thread");
  }
}
