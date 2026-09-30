import type { SqliteChatLog, StoredEvent } from "./chatLog.ts";
import { CLIENT_ID_RE, type ApprovalDecision, type DurableEventType, type HistoryResponse, type UploadRef, type WebHistoryItem } from "./events.ts";
import type { WebUploadPort } from "./workspaceAdapter.ts";

/** Durable events that show in history. Resolutions fold into the item they resolve. */
const HISTORY_EVENTS = ["user", "reply", "proactive", "ask", "approval", "session"] as const satisfies readonly DurableEventType[];

type UploadLookup = Pick<WebUploadPort, "lookup">;

/**
 * One page of the chat from the bot's own log: the newest `limit` items with a seq below `before`, oldest
 * first, within `maxBytes`. `before` in the result is the page's oldest seq, or null at the start.
 */
export function historyPage(
  log: SqliteChatLog,
  q: { before?: number; limit: number },
  deps: { uploads?: UploadLookup; maxBytes: number },
): HistoryResponse {
  const rows = log.page(HISTORY_EVENTS, { ...(q.before !== undefined ? { before: q.before } : {}), limit: q.limit + 1 });
  const more = rows.length > q.limit;
  const events = rows.slice(0, q.limit);
  const answers = new Map<string, string | null>();
  const askIds = events.flatMap((e) => (e.type === "ask" ? [(e as StoredEvent<"ask">).data.askId] : []));
  for (const r of log.list(["ask_resolved"], { keys: askIds }) as StoredEvent<"ask_resolved">[]) answers.set(r.data.askId, r.data.answer);
  const decisions = new Map<string, ApprovalDecision>();
  const nonces = events.flatMap((e) => (e.type === "approval" ? [(e as StoredEvent<"approval">).data.nonce] : []));
  const resolved = log.list(["approval_resolved"], { keys: nonces.flatMap((n) => [n, `${n}:result`]) }) as StoredEvent<"approval_resolved">[];
  for (const r of resolved) decisions.set(r.data.nonce, r.data.decision);
  const uploadIds = events.flatMap((e) => (e.type === "user" ? (e as StoredEvent<"user">).data.uploadIds : []));
  const known = deps.uploads && uploadIds.length ? deps.uploads.lookup([...new Set(uploadIds)]) : new Map<string, UploadRef>();

  const items: WebHistoryItem[] = [];
  let bytes = 0;
  let cut = false;
  for (const ev of events) {
    let item = toItem(ev, { answers, decisions, known });
    let size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size > deps.maxBytes / 2) {
      item = tooLarge(item);
      size = Buffer.byteLength(JSON.stringify(item)) + 1;
    }
    if (items.length && bytes + size > deps.maxBytes) {
      cut = true;
      break;
    }
    items.push(item);
    bytes += size;
  }
  const oldest = events[items.length - 1];
  return { items: items.reverse(), before: (more || cut) && oldest ? String(oldest.seq) : null };
}

function toItem(
  ev: StoredEvent,
  ctx: { answers: Map<string, string | null>; decisions: Map<string, ApprovalDecision>; known: Map<string, UploadRef> },
): WebHistoryItem {
  const id = String(ev.seq);
  const at = new Date(ev.createdAt).toISOString();
  switch (ev.type) {
    case "user": {
      const d = (ev as StoredEvent<"user">).data;
      const attachments = d.uploadIds.map((uid) => {
        const file = ctx.known.get(uid) ?? null;
        return { name: file?.name ?? "file", contentType: file?.contentType ?? "application/octet-stream", file };
      });
      // An imported message's key isn't a clientId: it never had an outbox entry to settle.
      return { type: "user", id, ...(CLIENT_ID_RE.test(d.key) ? { clientId: d.key } : {}), at: d.at, text: d.text, attachments };
    }
    case "reply":
    case "proactive": {
      const d = (ev as StoredEvent<"reply">).data;
      return {
        type: "assistant",
        id,
        at,
        text: d.text,
        outboxId: d.key,
        ...(d.turnId ? { turnId: d.turnId } : {}),
        tools: [],
        ...(d.usage ? { usage: d.usage } : {}),
        files: d.files,
      };
    }
    case "ask": {
      const d = (ev as StoredEvent<"ask">).data;
      const answer = ctx.answers.get(d.askId);
      return { type: "ask", id, at, outboxId: d.key, askId: d.askId, question: d.question, choices: d.choices, ...(answer !== undefined ? { answer } : {}) };
    }
    case "approval": {
      const d = (ev as StoredEvent<"approval">).data;
      return { type: "approval", id: `approval:${d.nonce}`, at, nonce: d.nonce, view: d.view, decision: ctx.decisions.get(d.nonce) ?? null };
    }
    default: {
      const d = (ev as StoredEvent<"session">).data;
      return { type: "divider", id, at, kind: d.kind === "new" ? "new" : "compacted" };
    }
  }
}

function tooLarge(item: WebHistoryItem): WebHistoryItem {
  return { type: "assistant", id: item.id, at: item.at, text: "[This message is too large to show here.]", tools: [], files: [] };
}
