import type { ChatCommand, ChatMessageMode } from "../contracts.ts";
import { RpcConnectionClosedError, mayHaveBeenAccepted } from "../transport/server.ts";
import type { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { getLogger } from "../../logger.ts";
import type { WorkspaceLink } from "./link.ts";
import type { AckKind, InboundMessage, InboundSurface, RouterNotice } from "./surface.ts";

const log = getLogger("orchestration/workspace/router");

const NEW_COMMANDS = new Set(["!new", "!reset", "!clear"]);
const STOP_COMMAND = "!stop";
/** The workspace's refusal text is shown to the owner and stored, so it is kept short. */
export const REJECTED_ERROR_MAX = 500;
const LOGIN_COMMAND_RE = /^!login(?:\s+(\S+))?$/i;
// Answered by the workspace without the model; `!tasks <project>` and `!model <alias>` take one argument.
const WORKSPACE_COMMAND_RE = /^!(compact|model|tasks)(?:\s+(.{1,200}))?$/is;

/** A `!compact` / `!model [alias]` / `!tasks [project]` message, else null. */
export function parseWorkspaceCommand(text: string): { command: ChatCommand; args?: string } | null {
  const m = WORKSPACE_COMMAND_RE.exec(text.trim());
  if (!m) return null;
  const command = m[1]!.toLowerCase() as ChatCommand;
  const args = m[2]?.trim();
  if (command === "compact" && args) return null;
  return args ? { command, args } : { command };
}

// Pi's redirect URI carries the authorization code, so it is matched anywhere and however it is wrapped.
const CALLBACK_HOST_PATH_RE = /(?:127\.0\.0\.1|localhost)(?::1455)?\/auth\/callback|:1455\/auth\/callback/i;
const CALLBACK_PATH_RE = /\/auth\/callback/i;
const CALLBACK_HOST_PORT_RE = /(?:127\.0\.0\.1|localhost):1455/i;
const CODE_PARAM_RE = /[?&#]code=/i;
const STATE_PARAM_RE = /[?&#]state=/i;
// Markdown, spoiler, quoting and bracket wrappers; never `_` or `-`, which end base64url values.
const CALLBACK_TOKEN_SPLIT = /[\s<>`'"*|~()[\]{}]+/;
const SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOST_RE = /127\.0\.0\.1|localhost/i;

/** Whether a message holds something shaped like the ChatGPT sign-in callback. */
export function looksLikeLoginCallback(text: string): boolean {
  if (CALLBACK_HOST_PATH_RE.test(text)) return true;
  if (CALLBACK_PATH_RE.test(text) && CODE_PARAM_RE.test(text) && STATE_PARAM_RE.test(text)) return true;
  return CALLBACK_HOST_PORT_RE.test(text) && CODE_PARAM_RE.test(text);
}

/** The callback URL inside a message that looks like one, unwrapped and with a scheme; null otherwise. */
export function detectLoginCallback(text: string): { url: string } | null {
  if (!looksLikeLoginCallback(text)) return null;
  const tokens = text.split(CALLBACK_TOKEN_SPLIT).filter(Boolean);
  const token =
    tokens.find((t) => CALLBACK_PATH_RE.test(t) && /[?&#](?:code|error)=/i.test(t)) ??
    tokens.find((t) => CALLBACK_PATH_RE.test(t) || CALLBACK_HOST_PORT_RE.test(t)) ??
    text.trim();
  let url = token.replace(/[.,;:!?]+$/, "");
  const scheme = SCHEME_RE.exec(url);
  if (scheme) url = url.slice(scheme.index);
  else {
    const host = LOCAL_HOST_RE.exec(url);
    url = `http://${(host ? url.slice(host.index) : url).replace(/^\/+/, "")}`;
  }
  return { url };
}

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
  link: Pick<WorkspaceLink, "isConnected" | "sendMessage" | "abort" | "newSession" | "recordOffline"> &
    Partial<Pick<WorkspaceLink, "interceptReply" | "isOwner" | "isLoginPending" | "startLogin" | "completeLogin" | "cancelLogin" | "command">>;
  /** The surface the message arrived on. */
  surface: InboundSurface<M>;
  cursor: MessageCursor;
  /** What happens to a message the workspace can't take. `fallback` (default) answers in-process and records
   *  the exchange for replay; `reject` records nothing and sends `workspaceOffline`, or `messageRejected`
   *  when a connected workspace refused it. */
  offline?: "fallback" | "reject";
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
  const reject = deps.offline === "reject";

  if (await routeLogin(message, deps, ack, notice)) return;

  // Replies to a buttonless prompt answer the bot, not the agent: they reach neither the workspace nor the fallback.
  const intercepted = (await link.interceptReply?.(message)) ?? { handled: false };
  if (intercepted.handled) {
    if (intercepted.ack) await ack(intercepted.ack);
    if (intercepted.notice) await notice(intercepted.notice);
    return;
  }

  if (NEW_COMMANDS.has(command)) {
    if (!deps.workspaceEnabled) {
      if (reject) await notice({ type: "workspaceOffline" });
      else await surface.resetFallback(message);
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

  const wsCommand = deps.workspaceEnabled && link.command ? parseWorkspaceCommand(message.text) : null;
  if (wsCommand && link.command) {
    if (!workspace) {
      await notice({ type: "commandOffline" });
      return;
    }
    await ack("accepted");
    try {
      const res = await link.command(wsCommand.command, wsCommand.args);
      await notice({ type: "commandResult", text: res.text });
    } catch (err) {
      log.warn({ err, command: wsCommand.command }, "chat/command failed");
      await notice({ type: "commandFailed", error: errorText(err) });
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

  let refused: { error: unknown } | null = null;
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
      log.warn({ err, messageId: message.id }, "chat/message not accepted by the workspace");
      refused = { error: err };
    }
  }

  // No receipt here. A receipt tells the surface the message was taken, so it would never be resent.
  if (reject) {
    // Only a link that is actually down is "offline"; a connected workspace that refused gets the error.
    if (refused && link.isConnected()) await notice({ type: "messageRejected", error: capError(errorText(refused.error)) });
    else await notice({ type: "workspaceOffline" });
    return;
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

/** `!login …` and any sign-in callback, which reaches only auth/complete and only while a login is pending.
 *  True when the message was consumed. */
async function routeLogin<M extends InboundMessage>(
  message: M,
  deps: OwnerRouterDeps<M>,
  ack: (kind: AckKind) => Promise<void>,
  notice: (n: RouterNotice) => Promise<void>,
): Promise<boolean> {
  const { link } = deps;
  const online = deps.workspaceEnabled && link.isConnected();
  const owner = link.isOwner?.(message.actor ?? { surface: message.origin.surface, userId: message.author.id, name: message.author.name }) ?? false;

  const callback = detectLoginCallback(message.text);
  if (callback) {
    if (!owner || !link.completeLogin || !link.isLoginPending?.()) {
      await notice({ type: "loginCallbackIgnored" });
      return true;
    }
    if (!online) {
      await notice({ type: "loginOffline" });
      return true;
    }
    await ack("accepted");
    const res = await link.completeLogin(callback.url);
    if (res.status === "inactive") await notice({ type: "loginCallbackIgnored" });
    else if (res.status === "offline") await notice({ type: "loginOffline" });
    else if (res.status === "failed") await notice({ type: "loginFailed", error: res.error });
    else if (res.status === "rejected") await notice({ type: "loginCallbackRejected", error: res.error });
    return true;
  }

  if (!owner || !link.isLoginPending || !link.startLogin || !link.completeLogin || !link.cancelLogin) return false;
  const text = message.text.trim();

  const command = LOGIN_COMMAND_RE.exec(text);
  if (!command) return false;
  const arg = command[1]?.toLowerCase();
  if (arg !== "chatgpt" && arg !== "cancel") {
    await notice({ type: "loginUsage" });
    return true;
  }
  if (!online) {
    await notice({ type: "loginOffline" });
    return true;
  }
  if (arg === "chatgpt") {
    const res = await link.startLogin(message.origin);
    if (res.status === "started") await ack("accepted");
    else if (res.status === "alreadyPending") await notice({ type: "loginAlreadyPending" });
    else if (res.status === "offline") await notice({ type: "loginOffline" });
    else if (res.status === "failed") await notice({ type: "loginFailed", error: res.error });
    return true;
  }
  const res = await link.cancelLogin();
  if (res.status === "cancelled") await ack("stopped");
  else if (res.status === "notPending") await notice({ type: "loginNotPending" });
  else if (res.status === "offline") await notice({ type: "loginOffline" });
  else if (res.status === "failed") await notice({ type: "loginFailed", error: res.error });
  return true;
}

/** One message, live or caught up. Only the owner's messages are handled, and each advances the cursor. */
export async function routeDirectMessage<T extends { id: string }>(
  message: T,
  deps: {
    isOwner: boolean;
    handleOwner: (message: T) => Promise<void>;
    cursor: MessageCursor;
    onOwnerDm?: (id: string) => void;
  },
): Promise<void> {
  if (!deps.isOwner) return;
  deps.onOwnerDm?.(message.id);
  try {
    await deps.handleOwner(message);
  } finally {
    deps.cursor.advance(message.id);
  }
}

function capError(text: string): string {
  return text.length > REJECTED_ERROR_MAX ? `${text.slice(0, REJECTED_ERROR_MAX - 1)}…` : text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
