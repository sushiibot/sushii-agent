import { getLogger } from "../../logger.ts";
import type { ChatLog, Subscription } from "./chatLog.ts";
import type { ChatEnvelope, PendingState, TurnView, WorkspaceState } from "./events.ts";

const log = getLogger("web/sse");

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_MAX_LIFETIME_MS = 15 * 60_000;
/** A client this far behind is cut off; it reconnects with its cursor and replays from the log. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface SseOptions {
  heartbeatMs: number;
  maxLifetimeMs: number;
  /** Runs when the stream opens; its return value runs when it closes. */
  onOpen(): () => void;
  /** Read in the same synchronous step as the subscription, so the first frame and the replay agree. */
  hello(): { workspace: WorkspaceState; openTurns: TurnView[]; pending: PendingState };
  signal?: AbortSignal;
  maxBufferedBytes?: number;
}

const encoder = new TextEncoder();

export function encodeEvent(ev: ChatEnvelope): Uint8Array {
  const id = ev.seq !== undefined ? `id: ${ev.seq}\n` : "";
  return encoder.encode(`${id}event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

const HEARTBEAT = encoder.encode(": hb\n\n");

/** The durable cursor from `?after=` or, failing that, `Last-Event-ID`; null when absent, undefined when malformed. */
export function parseCursor(req: Request): number | null | undefined {
  const raw = new URL(req.url).searchParams.get("after") ?? req.headers.get("Last-Event-ID");
  if (raw === null || raw === "") return null;
  if (!/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

/** A `text/event-stream` of `log` from `after`: `hello` (or `reset`) first, then the replay, then live
 *  events, with a heartbeat comment and a hard lifetime. */
export function sseResponse(chatLog: ChatLog, after: number | null, opts: SseOptions): Response {
  let cleanup: (() => void) | null = null;
  const maxBuffered = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let onClose: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let lifetime: ReturnType<typeof setTimeout> | null = null;
        let sub: Subscription | null = null;

        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (lifetime) clearTimeout(lifetime);
          sub?.close();
          onClose?.();
          opts.signal?.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            // Already closed or errored by the consumer.
          }
        };
        cleanup = close;

        const write = (bytes: Uint8Array) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) < -maxBuffered) {
            log.info("closing a web chat stream whose client stopped reading");
            close();
            return;
          }
          controller.enqueue(bytes);
        };
        // Never throws into the log's fan-out: a stream that can't take an event is closed, not left silent.
        const send = (ev: ChatEnvelope) => {
          try {
            write(encodeEvent(ev));
          } catch (err) {
            log.warn({ err, type: ev.type }, "closing a web chat stream that failed to write");
            close();
          }
        };

        const replay: ChatEnvelope[] = [];
        let live = false;
        sub = chatLog.subscribe(after, (ev) => (live ? send(ev) : replay.push(ev)));
        const state = opts.hello();
        if (sub.reset) {
          send({ type: "reset", data: { headSeq: sub.head, workspace: state.workspace, pending: state.pending } });
          send({ type: "workspace", data: { state: state.workspace } });
          for (const view of state.openTurns) send({ type: "snapshot", data: { turnId: view.turnId, view } });
        } else {
          send({ type: "hello", data: { headSeq: sub.head, workspace: state.workspace, openTurns: state.openTurns, pending: state.pending } });
          for (const ev of replay) send(ev);
        }
        replay.length = 0;
        live = true;
        // A replay past the buffer cap closes the stream before it opens; nothing below may outlive it.
        if (closed) return;

        onClose = opts.onOpen();
        heartbeat = setInterval(() => write(HEARTBEAT), opts.heartbeatMs);
        lifetime = setTimeout(close, opts.maxLifetimeMs);
        if (opts.signal?.aborted) close();
        else opts.signal?.addEventListener("abort", close, { once: true });
      },
      cancel() {
        cleanup?.();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
