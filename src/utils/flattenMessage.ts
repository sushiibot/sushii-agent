import { ComponentType, type Message } from "discord.js";
import type {
  ContainerComponent,
  FileComponent,
  MediaGalleryComponent,
  SectionComponent,
  TextDisplayComponent,
  ThumbnailComponent,
} from "discord.js";

type AnyComponent = Message["components"][number];

function mediaLabel(url: string): string {
  const filename = url.split("/").pop()?.split("?")[0] ?? "file";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp"];
  const type = imageExts.includes(ext) ? "image" : "file";
  return `[${type}: ${filename}]`;
}

function flattenComponents(components: readonly AnyComponent[]): string[] {
  const parts: string[] = [];
  for (const comp of components) {
    switch (comp.type) {
      case ComponentType.TextDisplay:
        parts.push((comp as TextDisplayComponent).content);
        break;
      case ComponentType.Section: {
        const section = comp as SectionComponent;
        parts.push(...flattenComponents(section.components as AnyComponent[]));
        if (section.accessory.type === ComponentType.Thumbnail) {
          parts.push(mediaLabel((section.accessory as ThumbnailComponent).media.url));
        }
        break;
      }
      case ComponentType.Container:
        parts.push(...flattenComponents((comp as ContainerComponent).components as AnyComponent[]));
        break;
      case ComponentType.MediaGallery:
        for (const item of (comp as MediaGalleryComponent).items) {
          parts.push(mediaLabel(item.media.url));
        }
        break;
      case ComponentType.File:
        parts.push(mediaLabel((comp as FileComponent).file.url));
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
  }
  for (const sticker of message.stickers.values()) {
    parts.push(`[sticker: ${sticker.name}]`);
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
