import { ComponentType, type Message } from "discord.js";
import type {
  ContainerComponent,
  SectionComponent,
  TextDisplayComponent,
} from "discord.js";

type AnyComponent = Message["components"][number];

function flattenComponents(components: readonly AnyComponent[]): string[] {
  const parts: string[] = [];
  for (const comp of components) {
    switch (comp.type) {
      case ComponentType.TextDisplay:
        parts.push((comp as TextDisplayComponent).content);
        break;
      case ComponentType.Section:
        parts.push(...flattenComponents((comp as SectionComponent).components as AnyComponent[]));
        break;
      case ComponentType.Container:
        parts.push(...flattenComponents((comp as ContainerComponent).components as AnyComponent[]));
        break;
    }
  }
  return parts;
}

export function flattenEmbeds(message: Pick<Message, "embeds">): string[] {
  return message.embeds.map((embed) => {
    const parts: string[] = [];
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields) {
      if (field.name === "decision_id") continue;
      parts.push(`${field.name}: ${field.value}`);
    }
    if (embed.footer?.text) parts.push(embed.footer.text);
    return `[embed: ${parts.join(" | ")}]`;
  });
}

/** Build a single content string from a discord.js Message. */
export function buildMessageContent(message: Message): string {
  const parts: string[] = [];

  if (message.content) {
    parts.push(message.content);
  } else {
    for (const sticker of message.stickers.values()) {
      parts.push(`[sticker: ${sticker.name}]`);
    }
  }

  for (const attachment of message.attachments.values()) {
    const label = attachment.name ?? "file";
    const type = attachment.contentType?.split("/")[0] ?? "attachment";
    parts.push(`[${type}: ${label}]`);
  }

  parts.push(...flattenEmbeds(message));
  parts.push(...flattenComponents(message.components as AnyComponent[]));

  return parts.join(" ") || "[empty message]";
}
