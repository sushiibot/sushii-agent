import { ComponentType, type Message, type MessageSnapshot } from "discord.js";
import type {
  ContainerComponent,
  FileComponent,
  MediaGalleryComponent,
  SectionComponent,
  TextDisplayComponent,
  ThumbnailComponent,
} from "discord.js";

type AnyComponent = Message["components"][number];

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

function isImageUrl(url: string): boolean {
  const filename = url.split("/").pop()?.split("?")[0] ?? "";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

function mediaLabel(url: string): string {
  const filename = url.split("/").pop()?.split("?")[0] ?? "file";
  const type = isImageUrl(url) ? "image" : "file";
  return `[${type}: ${filename}](${url})`;
}

/** Collects image URLs from Section thumbnails, MediaGallery items, and File components — these aren't listed in `message.attachments` once referenced by a component. */
export function collectComponentImageUrls(components: readonly AnyComponent[]): string[] {
  const urls: string[] = [];
  for (const comp of components) {
    switch (comp.type) {
      case ComponentType.Section: {
        const section = comp as SectionComponent;
        urls.push(...collectComponentImageUrls(section.components as AnyComponent[]));
        if (section.accessory.type === ComponentType.Thumbnail) {
          const url = (section.accessory as ThumbnailComponent).media.url;
          if (isImageUrl(url)) urls.push(url);
        }
        break;
      }
      case ComponentType.Container:
        urls.push(...collectComponentImageUrls((comp as ContainerComponent).components as AnyComponent[]));
        break;
      case ComponentType.MediaGallery:
        for (const item of (comp as MediaGalleryComponent).items) {
          if (isImageUrl(item.media.url)) urls.push(item.media.url);
        }
        break;
      case ComponentType.File: {
        const url = (comp as FileComponent).file.url;
        if (isImageUrl(url)) urls.push(url);
        break;
      }
    }
  }
  return urls;
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

type MessageLike = Pick<
  Message,
  "content" | "stickers" | "attachments" | "embeds" | "components"
>;

function flattenMessageFields(msg: MessageLike): string[] {
  const parts: string[] = [];

  if (msg.content) {
    parts.push(msg.content);
  }
  for (const sticker of msg.stickers.values()) {
    parts.push(`[sticker: ${sticker.name}]`);
  }
  for (const attachment of msg.attachments.values()) {
    const label = attachment.name ?? "file";
    const type = attachment.contentType?.split("/")[0] ?? "attachment";
    parts.push(`[${type}: ${label}](${attachment.url})`);
  }
  parts.push(...flattenEmbeds(msg));
  parts.push(...flattenComponents(msg.components as AnyComponent[]));

  return parts;
}

/** Build a single content string from a discord.js Message. */
export function buildMessageContent(message: Message): string {
  const parts = flattenMessageFields(message);

  for (const [messageId, snapshot] of message.messageSnapshots) {
    const ref = message.reference;
    const guildId = ref?.guildId;
    const channelId = ref?.channelId;
    const url =
      guildId && channelId
        ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
        : null;

    const inner = flattenMessageFields(snapshot as MessageLike).join(" ") || "[empty message]";
    parts.push(url ? `[forwarded from ${url}: ${inner}]` : `[forwarded: ${inner}]`);
  }

  return parts.join(" ") || "[empty message]";
}
