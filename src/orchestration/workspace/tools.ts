// Bot side of `tool/call`: the workspace runs its model elsewhere but calls these secret-holding tools
// here, executed with the bot's keys in the principal's private tool context. Owner approval is asked on
// the principal's preferred surface, since a tool/call carries no origin.
import { randomBytes, randomInt } from "node:crypto";
import { Check } from "typebox/schema";
import type { AuthorRef, ConversationRef, ConversationStore, SpaceMemoryStore, SurfaceId, SurfaceSession, ToolContext, ToolEntry, ToolHosts, ToolRegistry } from "../../core/contracts.ts";
import { buildToolContextBase } from "../../core/agentCore.ts";
import { createToolRegistry } from "../../core/tools/registry.ts";
import { toolCallParams, type ToolCallParams, type ToolCallResult, type ToolManifestEntry } from "../contracts.ts";
import type { ConnectionInfo } from "../transport/server.ts";
import { getLogger } from "../../logger.ts";
import { realTimers, type Timers } from "./progress.ts";
import {
  SurfaceUnavailableError,
  type ApprovalDecision,
  type ApprovalField,
  type ApprovalView,
  type ResolvedSurface,
  type SurfaceActor,
  type SurfaceMessageHandle,
  type SurfaceRegistry,
} from "./surface.ts";

const log = getLogger("orchestration/workspace/tools");

export const TOOL_EXEC_TIMEOUT_MS = 120_000;
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;
// An approved tool can't be cancelled once running (tool context has no abort signal), so it may finish after this.
const ASK_TIMEOUT_ERROR = "timeout after 120 s; the action may still complete, so do not retry it";

/** One argument shown on an approval prompt. `single` fields are shown in full on one line and rejected
 *  when longer than `max`; the `body` field is passed whole, for the surface to show or clip. */
export type DisplayField = { key: string; kind: "single"; max: number } | { key: string; kind: "body" };

export type ProxiedTool = { approval: "none" } | { approval: "ask"; display: readonly DisplayField[] };

/** The only tools a workspace can reach, and whether each needs the owner's click. A tool must be listed
 *  here to be proxied, whatever the registry offers. An ask tool's prompt shows only its `display`
 *  fields, and its args may hold no other keys. team_config is read-only, so it is `none`. */
export const PROXIED_TOOLS: Readonly<Record<string, ProxiedTool>> = {
  web_search: { approval: "none" },
  fetch_url_content: { approval: "none" },
  search_logs: { approval: "none" },
  get_trace: { approval: "none" },
  get_issue_status: { approval: "none" },
  list_triaged_issues: { approval: "none" },
  file_linear_issue: {
    approval: "ask",
    display: [
      { key: "repo_label", max: 100, kind: "single" },
      { key: "title", max: 256, kind: "single" },
      { key: "description", kind: "body" },
    ],
  },
  team_config: { approval: "none" },
};

export interface ToolCallAudit {
  principalId: string;
  agentId: string;
  agentName: string;
  parentRunId?: string;
  name: string;
  callId: string;
  durationMs: number;
  ok: boolean;
  denied: boolean;
}

export interface AuditLog {
  info(obj: ToolCallAudit, msg: string): void;
}

export interface WorkspaceToolsOptions {
  principalId: string;
  /** The owner's user id on `toolSpace.surface`; tools run as this user. Unset → no tools are offered. */
  ownerUserId: () => string | undefined;
  /** The private space tools run in: the context the in-process agent gets for the owner. */
  toolSpace: { surface: SurfaceId; spaceId: string };
  /** Where approval prompts go (the preferred surface). */
  surfaces: SurfaceRegistry;
  /** Who may decide an approval. Default: `ownerUserId` on `toolSpace.surface`. */
  isOwner?: (actor: SurfaceActor) => boolean;
  store: ConversationStore;
  memory: SpaceMemoryStore;
  registry?: ToolRegistry;
  timers?: Timers;
  now?: () => number;
  log?: AuditLog;
}

interface PendingApproval {
  conn: ConnectionInfo;
  resolve: (d: ApprovalDecision) => void;
  /** The reply code on a surface without buttons. */
  code?: { code: string; surface: string };
}

export type DecideResult = "decided" | "forbidden" | "expired";

// No 0/o, 1/l/i: the owner types the code back.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 6;

// 16 base64url chars: unguessable, colon-free, and independent of anything the workspace sends.
export const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;
function newNonce(): string {
  return randomBytes(12).toString("base64url");
}

const DENIED: ToolCallResult = { ok: false, error: "denied by owner", denied: true };

// Default-ignorable and format characters render as nothing or reorder text, so an approved prompt could
// hide part of what executes. Tag characters are listed explicitly: most are unassigned, so not \p{Cf}.
const INVISIBLE_RE = /[\p{Cf}\u{E0000}-\u{E007F}]/u;
export const INVISIBLE_ERROR = "invisible/format characters not allowed";

/** Whether any string in `value`, at any depth, holds an invisible or format character. */
export function hasInvisible(value: unknown): boolean {
  if (typeof value === "string") return INVISIBLE_RE.test(value);
  if (Array.isArray(value)) return value.some(hasInvisible);
  if (typeof value === "object" && value !== null) return Object.entries(value).some(([k, v]) => INVISIBLE_RE.test(k) || hasInvisible(v));
  return false;
}

export class WorkspaceTools {
  private readonly opts: WorkspaceToolsOptions;
  private readonly registry: ToolRegistry;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: AuditLog;
  // Keyed by a bot-generated nonce, never the callId, so a prompt can only settle the call it was posted for.
  private readonly pending = new Map<string, PendingApproval>();
  // callIds from arrival until settled, so a duplicate can't slip in while the prompt is being posted.
  private readonly claimed = new Set<string>();
  private readonly closed = new WeakSet<ConnectionInfo>();
  private readonly refused = new Set<string>();
  // Reply code → nonce, for prompts on surfaces without buttons; removed when the approval settles.
  private readonly codes = new Map<string, string>();

  constructor(opts: WorkspaceToolsOptions) {
    this.opts = opts;
    this.registry = opts.registry ?? createToolRegistry();
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (log as unknown as AuditLog);
    // Surfaces an unsupported schema at startup rather than on the first register.
    try {
      this.entries();
    } catch (err) {
      log.warn({ err }, "could not resolve the proxied tools");
    }
  }

  /** The proxied tools this bot can run right now: the allowlist, narrowed by the registry's config
   *  gates as resolved for the owner in their private space with no hosts (so no surface/cache/fs/mcp tools). */
  private entries(): Map<string, { entry: ToolEntry<keyof ToolHosts>; schema: Record<string, unknown> }> {
    if (!this.opts.ownerUserId()) return new Map();
    const session = { hosts: {}, capabilities: {} } as unknown as SurfaceSession;
    const resolved = this.registry.resolve(session, {
      surface: this.opts.toolSpace.surface,
      spaceId: this.opts.toolSpace.spaceId,
      autoMod: false,
      isOwner: true,
      isPrivate: true,
      authorized: true,
      moderationOn: false,
    });
    const out = new Map<string, { entry: ToolEntry<keyof ToolHosts>; schema: Record<string, unknown> }>();
    for (const entry of resolved) {
      if (!Object.hasOwn(PROXIED_TOOLS, entry.name)) continue;
      const schema = closedSchema(entry.definition.parameters);
      if (!schema) {
        if (!this.refused.has(entry.name)) log.warn({ tool: entry.name }, "not proxying a tool whose schema can't be closed");
        this.refused.add(entry.name);
        continue;
      }
      out.set(entry.name, { entry, schema });
    }
    return out;
  }

  manifest(): ToolManifestEntry[] {
    return [...this.entries().values()].map(({ entry, schema }) => ({
      name: entry.name,
      description: entry.definition.description,
      inputSchema: schema,
      approval: PROXIED_TOOLS[entry.name]!.approval,
    }));
  }

  async handleCall(conn: ConnectionInfo, raw: unknown): Promise<ToolCallResult> {
    const started = this.now();
    const parsed = toolCallParams.safeParse(raw);
    let result: ToolCallResult;
    if (!parsed.success) {
      result = { ok: false, error: `invalid tool/call params: ${parsed.error.issues[0]?.message ?? "malformed"}` };
    } else {
      try {
        result = await this.dispatch(conn, parsed.data);
      } catch (err) {
        result = { ok: false, error: errorText(err) };
      }
    }
    const p: Partial<ToolCallParams> = parsed.success ? parsed.data : pickStrings(raw);
    this.log.info(
      {
        principalId: p.principalId ?? conn.principalId ?? "",
        agentId: p.agentId ?? "",
        agentName: p.agentName ?? "",
        ...(p.parentRunId ? { parentRunId: p.parentRunId } : {}),
        name: p.name ?? "",
        callId: p.callId ?? "",
        durationMs: this.now() - started,
        ok: result.ok,
        denied: !result.ok && result.denied === true,
      },
      "workspace tool/call",
    );
    return result;
  }

  private async dispatch(conn: ConnectionInfo, p: ToolCallParams): Promise<ToolCallResult> {
    if (p.principalId !== this.opts.principalId || conn.principalId !== this.opts.principalId) return { ok: false, error: "principal mismatch" };
    const resolved = this.entries().get(p.name);
    if (!resolved) return { ok: false, error: `unknown tool: ${p.name}` };
    const { entry, schema } = resolved;
    const args = p.args === undefined ? {} : p.args;
    if (!Check(schema as Parameters<typeof Check>[0], args)) {
      return { ok: false, error: `invalid arguments for ${p.name}` };
    }
    if (hasInvisible(args)) return { ok: false, error: INVISIBLE_ERROR };
    const input = args as Record<string, unknown>;
    const policy = PROXIED_TOOLS[p.name]!;
    if (policy.approval === "none") return this.execute(entry, input, p, "timeout");
    const shown = approvalFields(policy.display, input);
    if (!shown.ok) return { ok: false, error: `invalid arguments for ${p.name}: ${shown.error}` };
    return this.executeWithApproval(conn, entry, input, p, shown.fields);
  }

  /** Runs the tool as the owner in their private space, the context the in-process agent gets. */
  private async execute(entry: ToolEntry<keyof ToolHosts>, input: Record<string, unknown>, p: ToolCallParams, timeoutError: string): Promise<ToolCallResult> {
    const ownerId = this.opts.ownerUserId();
    if (!ownerId) return { ok: false, error: "owner not configured" };
    const { surface, spaceId } = this.opts.toolSpace;
    const conversation: ConversationRef = { surface, spaceId, conversationId: `workspace:${this.opts.principalId}`, isPrivate: true };
    const owner: AuthorRef = { surface, userId: ownerId, username: "owner" };
    const base = buildToolContextBase({ conversation, isPrivate: true, store: this.opts.store, memory: this.opts.memory, hosts: {} });
    const ctx = { ...base, owner, turnId: p.callId } as ToolContext & Required<ToolHosts>;

    let timer: unknown;
    const timeout = new Promise<ToolCallResult>((resolve) => {
      timer = this.timers.set(() => resolve({ ok: false, error: timeoutError }), TOOL_EXEC_TIMEOUT_MS);
    });
    const run = entry.execute(input, ctx).then(
      (r): ToolCallResult => ({ ok: true, result: r.content }),
      (err): ToolCallResult => ({ ok: false, error: errorText(err) }),
    );
    try {
      return await Promise.race([run, timeout]);
    } finally {
      this.timers.clear(timer);
    }
  }

  private async executeWithApproval(conn: ConnectionInfo, entry: ToolEntry<keyof ToolHosts>, input: Record<string, unknown>, p: ToolCallParams, fields: ApprovalField[]): Promise<ToolCallResult> {
    if (this.claimed.has(p.callId)) return { ok: false, error: `duplicate callId: ${p.callId}` };
    this.claimed.add(p.callId);
    try {
      return await this.approveThenExecute(conn, entry, input, p, fields);
    } finally {
      this.claimed.delete(p.callId);
    }
  }

  private async approveThenExecute(conn: ConnectionInfo, entry: ToolEntry<keyof ToolHosts>, input: Record<string, unknown>, p: ToolCallParams, fields: ApprovalField[]): Promise<ToolCallResult> {
    let target: ResolvedSurface;
    try {
      target = this.opts.surfaces.resolve(null);
    } catch (err) {
      if (err instanceof SurfaceUnavailableError) return { ok: false, error: `${err.message}; cannot ask for approval` };
      return { ok: false, error: `failed to post the approval prompt: ${errorText(err)}` };
    }
    const { adapter, origin } = target;
    const nonce = newNonce();
    const code = adapter.capabilities.richButtons ? undefined : { code: this.newCode(), surface: adapter.surface };
    const view: ApprovalView = { tool: p.name, agentId: p.agentId, agentName: p.agentName, fields, ...(code ? { replyCode: code.code } : {}) };
    // Pending before the prompt exists, so a click racing the post's return still counts.
    const decided = this.awaitDecision(conn, nonce, code);
    let prompt: SurfaceMessageHandle;
    let resolve: (decision: ApprovalDecision, result?: ToolCallResult) => Promise<void>;
    try {
      prompt = await adapter.approvalPrompt(origin, view, nonce);
      resolve = (decision, result) => adapter.resolveApproval(prompt, view, nonce, decision, result).catch(() => {});
    } catch (err) {
      this.settle(nonce, "expired");
      if (err instanceof SurfaceUnavailableError) return { ok: false, error: `${err.message}; cannot ask for approval` };
      return { ok: false, error: `failed to post the approval prompt: ${errorText(err)}` };
    }

    if (this.closed.has(conn)) this.settle(nonce, "expired");
    const decision = await decided;
    if (decision !== "approve") {
      await resolve(decision);
      return DENIED;
    }
    // Disable the buttons while the tool runs, so a second click doesn't read as "expired".
    const running = resolve("approve");
    const result = await this.execute(entry, input, p, ASK_TIMEOUT_ERROR);
    await running;
    await resolve("approve", result);
    return result;
  }

  private newCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.codes.has(code)) return code;
    }
  }

  private awaitDecision(conn: ConnectionInfo, nonce: string, code: PendingApproval["code"]): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = this.timers.set(() => this.settle(nonce, "timeout"), APPROVAL_TIMEOUT_MS);
      if (code) this.codes.set(code.code, nonce);
      this.pending.set(nonce, {
        conn,
        ...(code ? { code } : {}),
        resolve: (d) => {
          this.timers.clear(timer);
          resolve(d);
        },
      });
    });
  }

  private settle(nonce: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(nonce);
    if (!p) return false;
    this.pending.delete(nonce);
    if (p.code) this.codes.delete(p.code.code);
    p.resolve(decision);
    return true;
  }

  isOwner(actor: SurfaceActor): boolean {
    if (this.opts.isOwner) return this.opts.isOwner(actor);
    const owner = this.opts.ownerUserId();
    return !!owner && actor.surface === this.opts.toolSpace.surface && actor.userId === owner;
  }

  /** The owner's decision on the prompt carrying `nonce`. `expired` when that prompt is no longer pending
   *  (decided, timed out, expired, or posted by an earlier process). */
  decide(nonce: string, decision: "approve" | "deny", actor: SurfaceActor): DecideResult {
    if (!this.isOwner(actor)) return "forbidden";
    return this.settle(nonce, decision) ? "decided" : "expired";
  }

  /** The owner's `approve <code>` / `deny <code>` reply. A code is single-use and only valid on the surface
   *  its prompt was posted to. */
  decideByCode(code: string, decision: "approve" | "deny", actor: SurfaceActor): boolean {
    const nonce = this.codes.get(code.toLowerCase());
    const pending = nonce ? this.pending.get(nonce) : undefined;
    if (!nonce || pending?.code?.surface !== actor.surface) return false;
    return this.decide(nonce, decision, actor) === "decided";
  }

  /** The socket a pending approval arrived on closed: its reply can't be delivered, so expire it. */
  onSocketClosed(conn: ConnectionInfo): void {
    this.closed.add(conn);
    for (const [nonce, p] of [...this.pending]) if (p.conn === conn) this.settle(nonce, "expired");
  }
}

/** The identifying string fields of a malformed tool/call, for its audit line; never args. */
function pickStrings(raw: unknown): Partial<ToolCallParams> {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  return { principalId: str("principalId"), agentId: str("agentId"), agentName: str("agentName"), parentRunId: str("parentRunId"), name: str("name"), callId: str("callId") };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Keywords closedSchema understands. Combinators, tuples, refs and pattern properties could carry keys
// past the closed objects, so a schema using anything else is refused rather than proxied.
const SCHEMA_KEYWORDS = new Set([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/** A copy of a tool's JSON Schema with `additionalProperties:false` on every object that declares
 *  properties (and on the root regardless), so args can carry nothing the tool doesn't define. Null
 *  when the schema uses a keyword this can't close. */
export function closedSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  const close = (node: unknown, root: boolean): Record<string, unknown> | null => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
    const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    if (Object.keys(out).some((k) => !SCHEMA_KEYWORDS.has(k))) return null;
    if (out.additionalProperties !== undefined && typeof out.additionalProperties !== "boolean") return null;
    const props = out.properties;
    if (props !== undefined) {
      if (typeof props !== "object" || props === null || Array.isArray(props)) return null;
      const closed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        const c = close(v, false);
        if (!c) return null;
        closed[k] = c;
      }
      out.properties = closed;
      out.additionalProperties = false;
    } else if (root) {
      out.properties = {};
      out.additionalProperties = false;
    }
    if (out.items !== undefined) {
      const items = close(out.items, false);
      if (!items) return null;
      out.items = items;
    }
    return out;
  };
  return close(schema, true);
}

/** The approval prompt's fields, taken only from the tool's display list in its fixed order. Empty values
 *  are skipped; a `single` value longer than its max is rejected rather than hidden. */
export function approvalFields(fields: readonly DisplayField[], args: Record<string, unknown>): { ok: true; fields: ApprovalField[] } | { ok: false; error: string } {
  const out: ApprovalField[] = [];
  for (const f of fields) {
    const raw = args[f.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (f.kind === "single" && value.length > f.max) return { ok: false, error: `${f.key} is longer than ${f.max} chars` };
    out.push(f.kind === "single" ? { key: f.key, value, kind: "single", max: f.max } : { key: f.key, value, kind: "body" });
  }
  return { ok: true, fields: out };
}
