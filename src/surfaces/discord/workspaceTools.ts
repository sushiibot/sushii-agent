// Bot side of `tool/call`: the workspace runs its model elsewhere but calls these secret-holding
// tools here, executed with the bot's keys and the owner-DM tool context. Lives in the Discord
// surface because the approval gate is a Components V2 prompt in the owner's DM.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, TextDisplayBuilder, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { Check } from "typebox/schema";
import type { AuthorRef, ConversationRef, ConversationStore, SpaceMemoryStore, SurfaceSession, ToolContext, ToolEntry, ToolHosts, ToolRegistry } from "../../core/contracts.ts";
import { buildToolContextBase } from "../../core/agentCore.ts";
import { createToolRegistry } from "../../core/tools/registry.ts";
import { toolCallParams, type ToolApproval, type ToolCallParams, type ToolCallResult, type ToolManifestEntry } from "../../orchestration/contracts.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import { getLogger } from "../../logger.ts";
import { DM_SPACE_ID } from "./dmConductor.ts";
import { ACCENT, type DmChannelPort, type EditableMessage, type Timers } from "./workspaceLink.ts";

export const WS_APPROVE_PREFIX = "wsap:";
export const TOOL_EXEC_TIMEOUT_MS = 120_000;
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;
// Discord caps custom_id at 100 chars: "wsap:" + callId + ":approve".
export const MAX_APPROVAL_CALL_ID = 100 - WS_APPROVE_PREFIX.length - ":approve".length;
const ARGS_SUMMARY_MAX = 600;
const ARG_VALUE_MAX = 200;
const RESULT_SUMMARY_MAX = 200;

type ApprovalRule = (args: Record<string, unknown>) => ToolApproval;
const never: ApprovalRule = () => "none";
const always: ApprovalRule = () => "ask";

/** The only tools a workspace can reach, and when each needs the owner's click. A tool must be listed
 *  here to be proxied, whatever the registry offers. team_config is read-only (a team list, or one
 *  team's detail with `team`); it has no write action, so every call is `none`. */
export const PROXIED_TOOLS: Readonly<Record<string, ApprovalRule>> = {
  web_search: never,
  fetch_url_content: never,
  search_logs: never,
  get_trace: never,
  get_issue_status: never,
  list_triaged_issues: never,
  file_linear_issue: always,
  team_config: never,
};

/** Manifest-level approval: "ask" when any call of the tool can need approval. */
const MANIFEST_APPROVAL: Readonly<Record<string, ToolApproval>> = { file_linear_issue: "ask" };

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
  /** The owner's Discord id; tools run as this user. Unset → no tools are offered. */
  ownerUserId: () => string | undefined;
  ownerChannel: () => Promise<DmChannelPort | null>;
  store: ConversationStore;
  memory: SpaceMemoryStore;
  registry?: ToolRegistry;
  timers?: Timers;
  now?: () => number;
  log?: AuditLog;
}

type Decision = "approve" | "deny" | "timeout" | "expired";

interface PendingApproval {
  conn: ConnectionInfo;
  resolve: (d: Decision) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const DENIED: ToolCallResult = { ok: false, error: "denied by owner", denied: true };

export class WorkspaceTools {
  private readonly opts: WorkspaceToolsOptions;
  private readonly registry: ToolRegistry;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: AuditLog;
  private readonly pending = new Map<string, PendingApproval>();
  // callIds from arrival until settled, so a duplicate can't slip in while the prompt is being posted.
  private readonly claimed = new Set<string>();
  private readonly closed = new WeakSet<ConnectionInfo>();

  constructor(opts: WorkspaceToolsOptions) {
    this.opts = opts;
    this.registry = opts.registry ?? createToolRegistry();
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (getLogger("surfaces/discord/workspaceTools") as unknown as AuditLog);
  }

  /** The proxied tools this bot can run right now: the allowlist, narrowed by the registry's config
   *  gates as resolved for the owner in their DM with no hosts (so no Discord/cache/fs/mcp tools). */
  private entries(): Map<string, ToolEntry<keyof ToolHosts>> {
    if (!this.opts.ownerUserId()) return new Map();
    const session = { hosts: {}, capabilities: {} } as unknown as SurfaceSession;
    const resolved = this.registry.resolve(session, {
      surface: "discord",
      spaceId: DM_SPACE_ID,
      autoMod: false,
      isOwner: true,
      isPrivate: true,
      authorized: true,
      moderationOn: false,
    });
    return new Map(resolved.filter((e) => Object.hasOwn(PROXIED_TOOLS, e.name)).map((e) => [e.name, e]));
  }

  manifest(): ToolManifestEntry[] {
    return [...this.entries().values()].map((e) => ({
      name: e.name,
      description: e.definition.description,
      inputSchema: e.definition.parameters,
      approval: MANIFEST_APPROVAL[e.name] ?? "none",
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
    const entry = this.entries().get(p.name);
    if (!entry) return { ok: false, error: `unknown tool: ${p.name}` };
    const args = p.args === undefined ? {} : p.args;
    if (!Check(entry.definition.parameters as Parameters<typeof Check>[0], args)) {
      return { ok: false, error: `invalid arguments for ${p.name}` };
    }
    const input = args as Record<string, unknown>;
    if (PROXIED_TOOLS[p.name]!(input) === "none") return this.execute(entry, input, p);
    return this.executeWithApproval(conn, entry, input, p);
  }

  /** Runs the tool as the owner in their DM space, the context the in-process DM agent gets. */
  private async execute(entry: ToolEntry<keyof ToolHosts>, input: Record<string, unknown>, p: ToolCallParams): Promise<ToolCallResult> {
    const ownerId = this.opts.ownerUserId();
    if (!ownerId) return { ok: false, error: "owner not configured" };
    const conversation: ConversationRef = { surface: "discord", spaceId: DM_SPACE_ID, conversationId: `workspace:${this.opts.principalId}`, isPrivate: true };
    const owner: AuthorRef = { surface: "discord", userId: ownerId, username: "owner" };
    const base = buildToolContextBase({ conversation, isPrivate: true, store: this.opts.store, memory: this.opts.memory, hosts: {} });
    const ctx = { ...base, owner, turnId: p.callId } as ToolContext & Required<ToolHosts>;

    let timer: unknown;
    const timeout = new Promise<ToolCallResult>((resolve) => {
      timer = this.timers.set(() => resolve({ ok: false, error: "timeout" }), TOOL_EXEC_TIMEOUT_MS);
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

  private async executeWithApproval(conn: ConnectionInfo, entry: ToolEntry<keyof ToolHosts>, input: Record<string, unknown>, p: ToolCallParams): Promise<ToolCallResult> {
    if (p.callId.length === 0 || p.callId.length > MAX_APPROVAL_CALL_ID) {
      return { ok: false, error: `callId must be 1-${MAX_APPROVAL_CALL_ID} chars for a tool that needs approval` };
    }
    if (this.claimed.has(p.callId)) return { ok: false, error: `duplicate callId: ${p.callId}` };
    this.claimed.add(p.callId);
    try {
      return await this.approveThenExecute(conn, entry, input, p);
    } finally {
      this.claimed.delete(p.callId);
    }
  }

  private async approveThenExecute(conn: ConnectionInfo, entry: ToolEntry<keyof ToolHosts>, input: Record<string, unknown>, p: ToolCallParams): Promise<ToolCallResult> {
    const prompt: ApprovalPrompt = { tool: p.name, agentId: p.agentId, agentName: p.agentName, argsSummary: summarizeArgs(input) };
    const channel = await this.opts.ownerChannel().catch(() => null);
    if (!channel) return { ok: false, error: "owner DM unavailable; cannot ask for approval" };
    let message: EditableMessage;
    try {
      message = await channel.send(renderApprovalPrompt(p.callId, prompt));
    } catch (err) {
      return { ok: false, error: `failed to post the approval prompt: ${errorText(err)}` };
    }

    const decision = this.closed.has(conn) ? "expired" : await this.awaitDecision(conn, p.callId);
    const edit = (options: MessageEditOptions) => message.edit(options).catch(() => {});
    if (decision !== "approve") {
      await edit(renderApprovalFinal(p.callId, prompt, decision));
      return DENIED;
    }
    // Disable the buttons while the tool runs, so a second click doesn't read as "expired".
    const running = edit(renderApprovalFinal(p.callId, prompt, "approve"));
    const result = await this.execute(entry, input, p);
    await running;
    await edit(renderApprovalFinal(p.callId, prompt, "approve", result));
    return result;
  }

  private awaitDecision(conn: ConnectionInfo, callId: string): Promise<Decision> {
    return new Promise((resolve) => {
      const timer = this.timers.set(() => this.settle(callId, "timeout"), APPROVAL_TIMEOUT_MS);
      this.pending.set(callId, {
        conn,
        resolve: (d) => {
          this.timers.clear(timer);
          resolve(d);
        },
      });
    });
  }

  private settle(callId: string, decision: Decision): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    this.pending.delete(callId);
    p.resolve(decision);
    return true;
  }

  /** An owner's click. False when the approval is no longer pending (decided, timed out, expired, or
   *  lost to a restart). */
  decide(callId: string, decision: "approve" | "deny"): boolean {
    return this.settle(callId, decision);
  }

  /** The socket a pending approval arrived on closed: its reply can't be delivered, so expire it. */
  onSocketClosed(conn: ConnectionInfo): void {
    this.closed.add(conn);
    for (const [callId, p] of [...this.pending]) if (p.conn === conn) this.settle(callId, "expired");
  }
}

interface ApprovalPrompt {
  tool: string;
  agentId: string;
  agentName: string;
  argsSummary: string;
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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Compact `key: value` lines for the approval prompt, capped at ARGS_SUMMARY_MAX chars. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const lines = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `**${k}:** ${clip((typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " "), ARG_VALUE_MAX)}`);
  return clip(lines.join("\n"), ARGS_SUMMARY_MAX);
}

function requesterLine(prompt: ApprovalPrompt): string {
  const name = prompt.agentName.replace(/`/g, "'");
  return `**${prompt.tool}** requested by \`${name}\`${prompt.agentId !== "main" ? " (subagent of main)" : ""}`;
}

function approvalButtons(callId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${WS_APPROVE_PREFIX}${callId}:approve`).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${WS_APPROVE_PREFIX}${callId}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function body(prompt: ApprovalPrompt): string {
  return [requesterLine(prompt), prompt.argsSummary].filter(Boolean).join("\n");
}

export function renderApprovalPrompt(callId: string, prompt: ApprovalPrompt): MessageCreateOptions {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT.warning)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `### 🙋 Approve action?\n${body(prompt)}\n-# auto-denies in 30 min` }))
    .addActionRowComponents(approvalButtons(callId, false));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

export function renderApprovalFinal(callId: string, prompt: ApprovalPrompt, decision: Decision, result?: ToolCallResult): MessageEditOptions {
  const header = { approve: "✅ Approved", deny: "❌ Denied", timeout: "⌛ Timed out", expired: "⌛ Expired (workspace disconnected)" }[decision];
  const outcome = result ? `\n-# → ${clip((result.ok ? result.result : `failed: ${result.error}`).split("\n")[0] ?? "", RESULT_SUMMARY_MAX)}` : "";
  const container = new ContainerBuilder()
    .setAccentColor(decision === "approve" ? ACCENT.success : ACCENT.danger)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: `### ${header}\n${body(prompt)}${outcome}` }))
    .addActionRowComponents(approvalButtons(callId, true));
  return { components: [container], allowedMentions: { parse: [] } };
}

/** Splits `wsap:<callId>:<approve|deny>`; the callId itself may contain colons. */
export function parseApprovalId(customId: string): { callId: string; decision: "approve" | "deny" } | null {
  if (!customId.startsWith(WS_APPROVE_PREFIX)) return null;
  const rest = customId.slice(WS_APPROVE_PREFIX.length);
  const i = rest.lastIndexOf(":");
  if (i <= 0) return null;
  const decision = rest.slice(i + 1);
  if (decision !== "approve" && decision !== "deny") return null;
  return { callId: rest.slice(0, i), decision };
}
