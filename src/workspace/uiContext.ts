import type { ExtensionUIContext, ExtensionUIDialogOptions, Theme } from "@earendil-works/pi-coding-agent";
import { getLogger } from "../logger.ts";
import { ulid } from "./ulid.ts";

const log = getLogger("workspace.ui");

/** How long an extension dialog waits for the owner before it resolves to its default. */
export const ASK_TIMEOUT_MS = 30 * 60_000;
/** chat/message id of a button answer; matches the bot's ASK_ANSWER_ID_PREFIX. */
export const ASK_ANSWER_PREFIX = "wsask:";
const CLOSED_KEPT = 100;

export interface AskRequest {
  askId: string;
  question: string;
  choices: string[];
}

/** Parses an answer text into the dialog's value, or null when the text doesn't answer it. */
type Parse<T> = (text: string) => { value: T } | null;

interface PendingAsk {
  askId: string;
  parse: Parse<unknown>;
  settle: (value: unknown) => void;
  fallback: unknown;
}

export type AnswerOutcome = "answered" | "stale" | null;

/**
 * Extension dialogs as chat asks. A `wsask:<askId>` message answers its own ask; any other user message
 * answers the oldest pending ask whose parser accepts it (any text for `input`).
 */
export class ChatAsks {
  private readonly pending: PendingAsk[] = [];
  private readonly closed: string[] = [];
  private readonly deliver: (ask: AskRequest) => void;
  private readonly timeoutMs: number;
  private readonly newId: () => string;

  constructor(opts: { deliver: (ask: AskRequest) => void; timeoutMs?: number; newId?: () => string }) {
    this.deliver = opts.deliver;
    this.timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
    this.newId = opts.newId ?? ulid;
  }

  get size(): number {
    return this.pending.length;
  }

  ask<T>(question: string, choices: string[], parse: Parse<T>, fallback: T, dialog?: ExtensionUIDialogOptions): Promise<T> {
    if (dialog?.signal?.aborted) return Promise.resolve(fallback);
    const askId = this.newId();
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => entry.settle(fallback);
      const entry: PendingAsk = {
        askId,
        parse: parse as Parse<unknown>,
        fallback,
        settle: (value) => {
          const i = this.pending.indexOf(entry);
          if (i === -1) return;
          this.pending.splice(i, 1);
          this.closed.push(askId);
          if (this.closed.length > CLOSED_KEPT) this.closed.shift();
          clearTimeout(timer);
          dialog?.signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
      };
      this.pending.push(entry);
      timer = setTimeout(() => {
        log.info({ askId }, "extension dialog timed out; using its default");
        entry.settle(fallback);
      }, dialog?.timeout ?? this.timeoutMs);
      timer.unref?.();
      dialog?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.deliver({ askId, question, choices });
      } catch (err) {
        log.warn({ err, askId }, "delivering an extension dialog failed; using its default");
        entry.settle(fallback);
      }
    });
  }

  /** Routes an owner message to a pending ask. "stale": a button answer for an ask no longer open. */
  answer(messageId: string, text: string): AnswerOutcome {
    const answer = text.trim();
    if (messageId.startsWith(ASK_ANSWER_PREFIX)) {
      const askId = messageId.slice(ASK_ANSWER_PREFIX.length);
      const entry = this.pending.find((p) => p.askId === askId);
      if (!entry) return "stale";
      const parsed = entry.parse(answer);
      entry.settle(parsed ? parsed.value : entry.fallback);
      return "answered";
    }
    for (const entry of this.pending) {
      const parsed = entry.parse(answer);
      if (parsed) {
        entry.settle(parsed.value);
        return "answered";
      }
    }
    return null;
  }

  /** Resolves every pending ask to its default, so a run parked in a dialog can end. */
  cancelAll(reason: string): void {
    if (this.pending.length) log.info({ reason, count: this.pending.length }, "cancelling open extension dialogs");
    for (const entry of [...this.pending]) entry.settle(entry.fallback);
  }
}

const YES = /^(y|yes|ok|okay|approve|allow|confirm|sure)$/i;
const NO = /^(n|no|deny|reject|cancel|decline)$/i;
const CONFIRM_CHOICES = ["Yes", "No"];

export function parseConfirm(text: string): { value: boolean } | null {
  if (YES.test(text)) return { value: true };
  if (NO.test(text)) return { value: false };
  return null;
}

/** A choice label, a 1-based number, or the bot's `(option N)` placeholder for a blank label. */
export function parseSelect(options: string[]): Parse<string> {
  return (text) => {
    const lower = text.toLowerCase();
    const byLabel = options.find((o) => o.trim().toLowerCase() === lower && o.trim() !== "");
    if (byLabel !== undefined) return { value: byLabel };
    const n = /^(?:\(option )?(\d{1,3})\)?$/i.exec(text);
    const i = n ? Number(n[1]) - 1 : -1;
    return i >= 0 && i < options.length ? { value: options[i]! } : null;
  };
}

const parseText: Parse<string> = (text) => (text ? { value: text } : null);

function question(title: string, detail?: string): string {
  return detail ? `${title}\n${detail}` : title;
}

const plain = (text: string) => text;

/** A Theme whose styling methods return the text unchanged: chat has no ANSI. */
export const plainTheme = {
  name: "plain",
  appearance: "dark",
  colors: {},
  style: plain,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: plain,
  italic: plain,
  underline: plain,
  inverse: plain,
  strikethrough: plain,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => plain,
  getBashModeBorderColor: () => plain,
} as unknown as Theme;

/** Pi's extension UI over the chat surface: dialogs become asks, TUI-only calls are no-ops, custom() declines. */
export function createHeadlessUIContext(asks: ChatAsks): ExtensionUIContext {
  return {
    select: (title, options, opts) => asks.ask(title, options, parseSelect(options), undefined as string | undefined, opts),
    confirm: (title, message, opts) => asks.ask(question(title, message), CONFIRM_CHOICES, parseConfirm, false, opts),
    input: (title, placeholder, opts) => asks.ask(question(title, placeholder), [], parseText, undefined as string | undefined, opts),
    editor: (title, prefill) => asks.ask(question(title, prefill), [], parseText, undefined as string | undefined),
    notify: (message, type) => log.info({ type: type ?? "info" }, `extension notice: ${message}`),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>() => {
      log.warn("an extension asked for a custom TUI component; declined (no terminal)");
      return undefined as T;
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return plainTheme;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "no terminal UI" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
