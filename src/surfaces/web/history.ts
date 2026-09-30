import type { HistoryItem } from "../../orchestration/contracts.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { SqliteChatLog, StoredEvent } from "./chatLog.ts";
import type { ApprovalDecision, HistoryResponse, UploadRef, WebHistoryItem } from "./events.ts";
import type { WebUploadPort } from "./workspaceAdapter.ts";

export interface HistorySource {
  page(q: { before?: string; limit: number }): Promise<{ items: HistoryItem[]; before: string | null }>;
}

/** Reads the Main transcript through the workspace's chat/history RPC. */
export class RpcHistorySource implements HistorySource {
  constructor(private readonly link: Pick<WorkspaceLink, "chatHistory">) {}

  page(q: { before?: string; limit: number }): Promise<{ items: HistoryItem[]; before: string | null }> {
    return this.link.chatHistory({ limit: q.limit, ...(q.before ? { before: q.before } : {}) });
  }
}

type UploadLookup = Pick<WebUploadPort, "lookup" | "forOutbox">;

/** One page of history: the workspace transcript joined with the bot's own record. An item matched to a bot
 *  event by clientId or outboxId renders from that event and is verified; anything else is workspace-only
 *  and unverified. Approvals come only from the bot's log. Items stay in the workspace's (chronological) order. */
export async function buildHistoryPage(
  source: HistorySource,
  q: { before?: string; limit: number },
  deps: { log: SqliteChatLog; uploads?: UploadLookup },
): Promise<HistoryResponse> {
  const page = await source.page(q);
  const { log } = deps;
  const clientIds = page.items.flatMap((i) => (i.type === "user" && i.clientId ? [i.clientId] : []));
  const outboxIds = page.items.flatMap((i) => (i.type === "assistant" && i.outboxId ? [i.outboxId] : i.type === "ask" ? [i.outboxId] : []));
  const users = byKey(log.list(["user"], { keys: clientIds }));
  const replies = byKey(log.list(["reply", "proactive"], { keys: outboxIds }));
  const asks = byKey(log.list(["ask"], { keys: outboxIds }));
  const askIds = page.items.flatMap((i) => (i.type === "ask" ? [i.askId] : []));
  const answers = byKey(log.list(["ask_resolved"], { keys: askIds }));
  const attachmentIds = page.items.flatMap((i) => (i.type === "user" ? i.attachments.flatMap((a) => (a.uploadId ? [a.uploadId] : [])) : []));
  for (const ev of users.values()) attachmentIds.push(...(ev as StoredEvent<"user">).data.uploadIds);
  const known = deps.uploads && attachmentIds.length ? deps.uploads.lookup([...new Set(attachmentIds)]) : new Map<string, UploadRef>();
  const refs = (id: string) => known.get(id) ?? null;
  const unmatched = outboxIds.filter((id) => !replies.has(id));
  const outboxFiles = deps.uploads && unmatched.length ? deps.uploads.forOutbox(unmatched) : new Map<string, UploadRef[]>();

  const items: WebHistoryItem[] = [];
  for (const item of page.items) {
    switch (item.type) {
      case "user": {
        const ev = item.clientId ? (users.get(item.clientId) as StoredEvent<"user"> | undefined) : undefined;
        if (ev) {
          const attachments = ev.data.uploadIds.map((id) => {
            const file = refs(id);
            return { name: file?.name ?? "file", contentType: file?.contentType ?? "application/octet-stream", file };
          });
          items.push({ type: "user", id: item.id, clientId: ev.data.key, at: ev.data.at, text: ev.data.text, attachments, verified: true });
        } else {
          const attachments = item.attachments.map((a) => ({ name: a.name, contentType: a.contentType, file: a.uploadId ? refs(a.uploadId) : null }));
          items.push({ type: "user", id: item.id, ...(item.clientId ? { clientId: item.clientId } : {}), at: item.at, text: item.text, attachments, verified: false });
        }
        break;
      }
      case "assistant": {
        const ev = item.outboxId ? (replies.get(item.outboxId) as StoredEvent<"reply"> | undefined) : undefined;
        const usage = ev ? ev.data.usage : item.usage;
        items.push({
          type: "assistant",
          id: item.id,
          at: item.at,
          text: ev ? ev.data.text : item.text,
          ...(item.outboxId ? { outboxId: item.outboxId } : {}),
          ...((ev?.data.turnId ?? item.turnId) ? { turnId: ev?.data.turnId ?? item.turnId } : {}),
          tools: item.tools,
          ...(usage ? { usage } : {}),
          files: ev ? ev.data.files : item.outboxId ? (outboxFiles.get(item.outboxId) ?? []) : [],
          verified: ev !== undefined,
        });
        break;
      }
      case "ask": {
        const ev = asks.get(item.outboxId) as StoredEvent<"ask"> | undefined;
        const askId = ev ? ev.data.askId : item.askId;
        const answer = (answers.get(askId) as StoredEvent<"ask_resolved"> | undefined)?.data.answer;
        items.push({
          type: "ask",
          id: item.id,
          at: item.at,
          outboxId: item.outboxId,
          askId,
          question: ev ? ev.data.question : item.question,
          choices: ev ? ev.data.choices : item.choices,
          ...(answer !== undefined ? { answer } : {}),
          verified: ev !== undefined,
        });
        break;
      }
      case "divider":
        items.push({ type: "divider", id: item.id, at: item.at, kind: item.kind, ...(item.summary !== undefined ? { summary: item.summary } : {}) });
        break;
    }
  }
  const approvals = await approvalsIn(log, source, page.items, q.before === undefined, page.before);
  return { items: spliceApprovals(items, approvals), before: page.before };
}

function byKey(events: StoredEvent[]): Map<string, StoredEvent> {
  const out = new Map<string, StoredEvent>();
  for (const ev of events) if (ev.key !== null) out.set(ev.key, ev);
  return out;
}

const atMs = (at: string) => {
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
};

/** The bot's approvals in this page's span, (at of the next older item, at of this page's newest item]; the
 *  newest page runs on to now. Adjacent pages share a boundary, so an approval lands on exactly one page. */
async function approvalsIn(log: SqliteChatLog, source: HistorySource, items: HistoryItem[], newest: boolean, olderCursor: string | null): Promise<WebHistoryItem[]> {
  const all = log.list(["approval"]) as StoredEvent<"approval">[];
  if (!all.length) return [];
  const times = items.map((i) => atMs(i.at)).filter((t): t is number => t !== null);
  if (!times.length && !newest) return [];
  const to = newest ? Infinity : Math.max(...times);
  let from = -Infinity;
  const min = times.length ? Math.min(...times) : Infinity;
  if (olderCursor !== null && all.some((a) => a.createdAt < min)) {
    const probe = await source.page({ before: olderCursor, limit: 1 }).catch(() => null);
    const older = probe?.items.map((i) => atMs(i.at)).filter((t): t is number => t !== null) ?? [];
    from = older.length ? Math.max(...older) : min;
  }
  const approvals = all.filter((e) => e.createdAt > from && e.createdAt <= to);
  if (!approvals.length) return [];
  const decisions = new Map<string, ApprovalDecision>();
  const resolved = log.list(["approval_resolved"], { keys: approvals.flatMap((a) => [a.data.nonce, `${a.data.nonce}:result`]) }) as StoredEvent<"approval_resolved">[];
  for (const r of resolved) decisions.set(r.data.nonce, r.data.decision);
  return approvals.map((a) => ({
    type: "approval",
    id: `approval:${a.data.nonce}`,
    at: new Date(a.createdAt).toISOString(),
    nonce: a.data.nonce,
    view: a.data.view,
    decision: decisions.get(a.data.nonce) ?? null,
  }));
}

/** Inserts each approval before the first item that is later than it. */
function spliceApprovals(items: WebHistoryItem[], approvals: WebHistoryItem[]): WebHistoryItem[] {
  if (!approvals.length) return items;
  const out = [...items];
  for (const a of approvals) {
    const t = atMs(a.at)!;
    const i = out.findIndex((x) => (atMs(x.at) ?? -Infinity) > t);
    out.splice(i === -1 ? out.length : i, 0, a);
  }
  return out;
}
