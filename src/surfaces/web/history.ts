import { CHAT_HISTORY_TIMEOUT_MS, ID_MAX, type HistoryItem } from "../../orchestration/contracts.ts";
import type { WorkspaceLink } from "../../orchestration/workspace/link.ts";
import type { SqliteChatLog, StoredEvent } from "./chatLog.ts";
import { MESSAGE_TEXT_MAX, MESSAGE_UPLOADS_MAX, type ApprovalDecision, type HistoryResponse, type UploadRef, type WebHistoryItem } from "./events.ts";
import { capText, REPLY_TEXT_MAX, TOOL_SUMMARY_MAX, type WebUploadPort } from "./workspaceAdapter.ts";

export interface HistorySource {
  page(q: { before?: string; limit: number }, timeoutMs?: number): Promise<{ items: HistoryItem[]; before: string | null }>;
}

export class RpcHistorySource implements HistorySource {
  constructor(private readonly link: Pick<WorkspaceLink, "chatHistory">) {}

  page(q: { before?: string; limit: number }, timeoutMs?: number): Promise<{ items: HistoryItem[]; before: string | null }> {
    return this.link.chatHistory({ limit: q.limit, ...(q.before ? { before: q.before } : {}) }, timeoutMs);
  }
}

/** The history route's shared time budget ran out. */
export class HistoryDeadlineError extends Error {}

/** A wall-clock budget shared by every RPC one history request makes. */
export interface HistoryDeadline {
  at: number;
  now: () => number;
}

/** One page, bounded by what is left of `deadline`. */
function fetchPage(source: HistorySource, q: { before?: string; limit: number }, deadline: HistoryDeadline | undefined) {
  if (!deadline) return source.page(q);
  const left = deadline.at - deadline.now();
  if (left <= 0) return Promise.reject(new HistoryDeadlineError("history deadline passed"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HistoryDeadlineError("history deadline passed")), left);
  });
  return Promise.race([source.page(q, Math.min(left, CHAT_HISTORY_TIMEOUT_MS)), expired]).finally(() => clearTimeout(timer));
}

type UploadLookup = Pick<WebUploadPort, "lookup">;

const HISTORY_TOOLS_MAX = 50;
const HISTORY_CHOICES_MAX = 25;
const HISTORY_ATTACHMENTS_MAX = 2 * MESSAGE_UPLOADS_MAX;

export interface HistoryPage {
  response: HistoryResponse;
  /** The lowest owner-message seq verified on this page or any newer one; the next older page verifies only below it. */
  userFloor: number;
}

/** Joins a workspace transcript page with the bot's own record. An item matched to a bot event by clientId
 *  or outboxId renders from that event and is verified; the rest are unverified. Owner messages verify
 *  only below `userFloor` and in the bot's order, so one is verified on at most one page of a walk and
 *  never shown ahead of a message the owner sent before it. Approvals come only from the bot's log. Items
 *  keep the workspace's oldest-first order. */
export async function buildHistoryPage(
  source: HistorySource,
  q: { before?: string; limit: number },
  deps: { log: SqliteChatLog; uploads?: UploadLookup; userFloor?: number; deadline?: HistoryDeadline },
): Promise<HistoryPage> {
  const page = await fetchPage(source, q, deps.deadline);
  const { log } = deps;
  const floor = deps.userFloor ?? Infinity;
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

  // The workspace can repeat an id; only its first item may claim the bot's record, so a record verifies once.
  const claimed = new Set<StoredEvent>();
  const claim = <E extends StoredEvent>(ev: E | undefined): E | undefined => {
    if (!ev || claimed.has(ev)) return undefined;
    claimed.add(ev);
    return ev;
  };

  const items: WebHistoryItem[] = [];
  // Where each item sits in time for placing approvals: the bot's own receive time when it has the item.
  const times: (number | null)[] = [];
  // Verified owner messages must appear in the bot's order: one placed before an earlier-sent one isn't verified.
  let lastOwnerSeq = -Infinity;
  let lowestOwnerSeq = floor;
  for (const item of page.items) {
    switch (item.type) {
      case "user": {
        const match = item.clientId ? (users.get(item.clientId) as StoredEvent<"user"> | undefined) : undefined;
        const ev = match && match.seq < floor && match.seq > lastOwnerSeq ? claim(match) : undefined;
        times.push(match ? match.createdAt : atMs(item.at));
        if (ev) {
          lastOwnerSeq = ev.seq;
          lowestOwnerSeq = Math.min(lowestOwnerSeq, ev.seq);
          const attachments = ev.data.uploadIds.map((id) => {
            const file = refs(id);
            return { name: file?.name ?? "file", contentType: file?.contentType ?? "application/octet-stream", file };
          });
          items.push({ type: "user", id: item.id, clientId: ev.data.key, at: ev.data.at, text: ev.data.text, attachments, verified: true });
        } else {
          const attachments = item.attachments
            .slice(0, HISTORY_ATTACHMENTS_MAX)
            .map((a) => ({ name: a.name, contentType: a.contentType, file: a.uploadId ? refs(a.uploadId) : null }));
          items.push({ type: "user", id: item.id, at: item.at, text: capText(item.text, MESSAGE_TEXT_MAX), attachments, verified: false });
        }
        break;
      }
      case "assistant": {
        const known = item.outboxId ? (replies.get(item.outboxId) as StoredEvent<"reply"> | undefined) : undefined;
        times.push(known ? known.createdAt : atMs(item.at));
        const ev = claim(known);
        const usage = ev ? ev.data.usage : item.usage;
        const turnId = ev ? ev.data.turnId : item.turnId;
        items.push({
          type: "assistant",
          id: item.id,
          at: item.at,
          text: ev ? ev.data.text : capText(item.text, REPLY_TEXT_MAX),
          ...(item.outboxId ? { outboxId: item.outboxId } : {}),
          ...(turnId ? { turnId } : {}),
          // Tool lines come only from the transcript, so a verified bubble doesn't show them.
          tools: ev ? [] : item.tools.slice(0, HISTORY_TOOLS_MAX).map((t) => ({ ...t, summary: capText(t.summary, TOOL_SUMMARY_MAX) })),
          ...(usage ? { usage } : {}),
          files: ev ? ev.data.files : [],
          verified: ev !== undefined,
        });
        break;
      }
      case "ask": {
        const known = asks.get(item.outboxId) as StoredEvent<"ask"> | undefined;
        times.push(known ? known.createdAt : atMs(item.at));
        const ev = claim(known);
        const askId = ev ? ev.data.askId : item.askId;
        const answer = (answers.get(askId) as StoredEvent<"ask_resolved"> | undefined)?.data.answer;
        items.push({
          type: "ask",
          id: item.id,
          at: item.at,
          outboxId: item.outboxId,
          askId,
          question: ev ? ev.data.question : capText(item.question, MESSAGE_TEXT_MAX),
          choices: ev ? ev.data.choices : item.choices.slice(0, HISTORY_CHOICES_MAX).map((c) => capText(c, ID_MAX)),
          ...(answer !== undefined ? { answer } : {}),
          verified: ev !== undefined,
        });
        break;
      }
      case "divider":
        times.push(atMs(item.at));
        items.push({ type: "divider", id: item.id, at: item.at, kind: item.kind, ...(item.summary !== undefined ? { summary: capText(item.summary, MESSAGE_TEXT_MAX) } : {}) });
        break;
    }
  }
  const approvals = await approvalsIn(log, source, times, q.before === undefined, page.before, deps.deadline);
  return { response: { items: spliceApprovals(items, times, approvals), before: page.before }, userFloor: lowestOwnerSeq };
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

/** The bot's receive time for a workspace item it has a record of, else the workspace's own time. */
function botTime(log: SqliteChatLog, item: HistoryItem): number | null {
  const ev =
    item.type === "user" && item.clientId
      ? log.find("user", item.clientId)
      : item.type === "assistant" && item.outboxId
        ? (log.find("reply", item.outboxId) ?? log.find("proactive", item.outboxId))
        : item.type === "ask"
          ? log.find("ask", item.outboxId)
          : null;
  return ev ? ev.createdAt : atMs(item.at);
}

/** The bot's approvals after the next older item and up to this page's newest item, or up to now on the
 *  newest page. Adjacent pages share a boundary, so each approval lands on one page. */
async function approvalsIn(
  log: SqliteChatLog,
  source: HistorySource,
  itemTimes: (number | null)[],
  newest: boolean,
  olderCursor: string | null,
  deadline: HistoryDeadline | undefined,
): Promise<WebHistoryItem[]> {
  const all = log.list(["approval"]) as StoredEvent<"approval">[];
  if (!all.length) return [];
  const times = itemTimes.filter((t): t is number => t !== null);
  if (!times.length && !newest) return [];
  const to = newest ? Infinity : Math.max(...times);
  let from = -Infinity;
  const min = times.length ? Math.min(...times) : Infinity;
  if (olderCursor !== null && all.some((a) => a.createdAt < min)) {
    // Without the older page's boundary an approval could land on neither page; showing it twice is safer.
    const probe = await fetchPage(source, { before: olderCursor, limit: 1 }, deadline).catch(() => null);
    const older = probe?.items.map((i) => botTime(log, i)).filter((t): t is number => t !== null) ?? [];
    from = !probe ? -Infinity : older.length ? Math.max(...older) : min;
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

function spliceApprovals(items: WebHistoryItem[], itemTimes: (number | null)[], approvals: WebHistoryItem[]): WebHistoryItem[] {
  if (!approvals.length) return items;
  const out = items.map((item, i) => ({ item, t: itemTimes[i] ?? -Infinity }));
  for (const a of approvals) {
    const t = atMs(a.at)!;
    const i = out.findIndex((x) => x.t > t);
    out.splice(i === -1 ? out.length : i, 0, { item: a, t });
  }
  return out.map((x) => x.item);
}
