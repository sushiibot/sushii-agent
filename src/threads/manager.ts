import type { Message, ThreadChannel } from "discord.js";
import type { ModelMessage, TextPart } from "ai";
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
  });

  return { thread, isNew: true };
}

function extractText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p): p is TextPart => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
  }
  return "";
}

export async function renameThread(
  thread: ThreadChannel,
  history: ModelMessage[],
): Promise<void> {
  try {
    const textHistory = history
      .filter((m): m is ModelMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
      .flatMap((m) => {
        const text = extractText(m.content);
        return text ? [{ role: m.role, content: text.slice(0, 500) }] : [];
      })
      .slice(-6);

    const result = await generateText({
      model: openaiProvider(config.openaiModel),
      messages: [
        ...textHistory,
        {
          role: "user",
          content:
            "Write a thread title of 5 words or fewer summarizing this conversation topic. Do not include any person's name or username. Return only the title, no quotes or punctuation.",
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
