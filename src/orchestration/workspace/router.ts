import type { ChatMessageMode } from "../contracts.ts";
import { RpcConnectionClosedError, mayHaveBeenAccepted } from "../transport/server.ts";
import type { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { getLogger } from "../../logger.ts";
import type { WorkspaceLink } from "./link.ts";
import type { AckKind, InboundMessage, InboundSurface } from "./surface.ts";

const log = getLogger("orchestration/workspace/router");

const NEW_COMMANDS = new Set(["!new", "!reset", "!clear"]);
const STOP_COMMAND = "!stop";

/** The last message the router handled on one conversation; `advance` only ever moves it forward. */
export interface MessageCursor {
  advance(id: string): void;
}

/** A cursor persisted in the link store's kv table. */
export function kvCursor(store: Pick<WorkspaceLinkStore, "getKv" | "setKv">, key: string): { get(): string | null; set(id: string): void } {
  return { get: () => store.getKv(key), set: (id) => store.setKv(key, id) };
}

export interface OwnerRouterDeps<M extends InboundMessage> {
  workspaceEnabled: boolean;
  transcriptionEnabled: boolean;
  link: Pick<WorkspaceLink, "isConnected" | "sendMessage" | "abort" | "newSession" | "recordOffline">;
  /** The surface the message arrived on. */
  surface: InboundSurface<M>;
  cursor: MessageCursor;
}

/** The receipt for how the workspace took a message; none for a duplicate or context. */
export function modeAck(mode: ChatMessageMode): AckKind | null {
  if (mode === "prompt") return "accepted";
  if (mode === "steer") return "steer";
  return null;
}

/** Routes one of the principal's messages: to the workspace when enabled and connected, else to the
 *  in-process fallback agent. */
export async function handleOwnerMessage<M extends InboundMessage>(message: M, deps: OwnerRouterDeps<M>): Promise<void> {
  try {
    await route(message, deps);
  } finally {
    deps.cursor.advance(message.id);
  }
}

async function route<M extends InboundMessage>(message: M, deps: OwnerRouterDeps<M>): Promise<void> {
  const { link, surface } = deps;
  const command = message.text.trim().toLowerCase();
  const workspace = deps.workspaceEnabled && link.isConnected();
  const ack = (kind: AckKind) => surface.ack(message, kind).catch(() => {});
  const notice = (n: Parameters<InboundSurface<M>["notice"]>[1]) => surface.notice(message, n).catch(() => {});

  if (NEW_COMMANDS.has(command)) {
    if (!deps.workspaceEnabled) {
      await surface.resetFallback(message);
      return;
    }
    if (!workspace) {
      // Clearing the fallback's history would read as a new session, but the workspace's continues on reconnect.
      await notice({ type: "newWhileOffline" });
      return;
    }
    await ack("newSession");
    try {
      await link.newSession();
      await notice({ type: "newSessionStarted" });
    } catch (err) {
      log.warn({ err }, "chat/new failed");
      await notice({ type: "newSessionFailed", error: errorText(err) });
    }
    return;
  }

  if (deps.workspaceEnabled && command === STOP_COMMAND) {
    if (!workspace) {
      await notice({ type: "nothingToStop" });
      return;
    }
    try {
      await link.abort();
      await ack("stopped");
    } catch (err) {
      log.warn({ err }, "chat/abort failed");
      await notice({ type: "stopFailed", error: errorText(err) });
    }
    return;
  }

  let text = message.text;
  let voice = false;
  if (deps.transcriptionEnabled && message.isVoice) {
    await ack("transcribing");
    const transcript = await surface.transcribe(message);
    if (!transcript) {
      await notice({ type: "transcriptionFailed" });
      return;
    }
    text = transcript;
    voice = true;
    await notice({ type: "transcript", text: transcript });
  }

  if (workspace) {
    // A voice message's audio is already transcribed; only forward real attachments.
    const attachments = voice ? [] : message.attachments;
    const send = () =>
      link.sendMessage({
        origin: message.origin,
        messageId: message.id,
        text,
        kind: "user",
        author: message.author,
        ...(attachments.length ? { attachments } : {}),
        ...(voice ? { voice: true } : {}),
      });
    try {
      let res;
      try {
        res = await send();
      } catch (err) {
        // A replacement socket took over; the old one likely died before the workspace read the message.
        // The workspace dedupes by messageId, so a retry of one it did take comes back as a duplicate.
        if (!(err instanceof RpcConnectionClosedError && link.isConnected())) throw err;
        res = await send();
      }
      const kind = modeAck(res.mode);
      if (kind) await ack(kind);
      return;
    } catch (err) {
      // The workspace dedupes by messageId and answers a message it took, so answering here too would double-reply.
      if (mayHaveBeenAccepted(err) && link.isConnected()) {
        log.warn({ err, messageId: message.id }, "chat/message unconfirmed while the workspace is connected; leaving it to the workspace");
        await ack("queued");
        return;
      }
      log.warn({ err, messageId: message.id }, "chat/message not accepted; answering in-process");
    }
  }

  // Immediate receipt ack; the in-process turn can take a while.
  await ack("accepted");
  if (!deps.workspaceEnabled) {
    await surface.fallbackReply(message, text, { offline: false });
    return;
  }
  const reply = await surface.fallbackReply(message, text, { offline: true });
  deps.link.recordOffline(text, reply ?? "(no reply)", message.origin);
}

/** One message, live or caught up: pre-checks (task replies, pending answers) consume it first; otherwise
 *  the principal's own message goes to the owner router. Every owner message advances the cursor,
 *  whichever branch took it. */
export async function routeDirectMessage<T extends { id: string }>(
  message: T,
  deps: {
    isOwner: boolean;
    preChecks: Array<(message: T) => Promise<boolean>>;
    handleOwner: (message: T) => Promise<void>;
    cursor: MessageCursor;
    onOwnerDm?: (id: string) => void;
  },
): Promise<void> {
  if (deps.isOwner) deps.onOwnerDm?.(message.id);
  try {
    for (const check of deps.preChecks) if (await check(message)) return;
    if (deps.isOwner) await deps.handleOwner(message);
  } finally {
    if (deps.isOwner) deps.cursor.advance(message.id);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
