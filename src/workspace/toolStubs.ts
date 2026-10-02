import type { AgentSession, AgentToolResult, ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RPC_METHODS, type ToolCallParams, type ToolCallResult, type ToolCancelParams, type ToolManifestEntry, type ChatOrigin } from "../orchestration/contracts.ts";
import { ConnectionClosedError, NotConnectedError, RequestTimeoutError } from "../orchestration/transport/client.ts";
import { getLogger } from "../logger.ts";
import { ulid } from "./ulid.ts";

const log = getLogger("workspace.tools");

/**
 * Names the bot may proxy (its PROXIED_TOOLS). Pi freezes a session's tool allowlist at creation, so a
 * stub can only be registered later under a name listed here; a manifest name outside it is skipped.
 */
export const KNOWN_PROXIED_TOOLS: readonly string[] = [
  "web_search",
  "fetch_url_content",
  "search_logs",
  "get_trace",
  "get_issue_status",
  "list_triaged_issues",
  "file_linear_issue",
  "team_config",
  "request_current_location",
];

/** Above the bot's 30 min approval wait plus its 120 s execution cap. */
export const ASK_TOOL_TIMEOUT_MS = 33 * 60_000;
/** Above the bot's 120 s execution cap. */
export const TOOL_TIMEOUT_MS = 150_000;

export const TOOL_CANCEL_TIMEOUT_MS = 10_000;

export function toolTimeoutMs(approval: ToolManifestEntry["approval"]): number {
  return approval === "ask" ? ASK_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
}

/** Which agent a tool/call runs for: "main" for the chat session, a subagent's runId otherwise. */
export interface StubAgentContext {
  agentId: string;
  agentName: string;
  parentRunId?: string;
  origin?: ChatOrigin;
}

export const MAIN_AGENT: StubAgentContext = { agentId: "main", agentName: "main" };

export const DENIED_TEXT = "The owner denied this call. Do not retry it; ask drk in chat if it still seems needed.";
export const LINK_CLOSED_TEXT = "workspace link closed; the call may or may not have completed — check before retrying";

export interface ToolStubsOptions {
  principalId: string;
  /** One JSON-RPC request to the bot, never retried (OrchestrationClient.request). */
  request: (method: string, params: ToolCallParams | ToolCancelParams, timeoutMs: number) => Promise<unknown>;
  newId?: () => string;
}

type StubResult = AgentToolResult<{ callId: string }>;

/** Proxies the bot's secret-holding tools into Pi sessions, one stub per register-result manifest entry. */
export class ToolStubs {
  private readonly opts: ToolStubsOptions;
  private manifest = new Map<string, ToolManifestEntry>();
  private readonly bindings = new Set<StubBinding>();

  constructor(opts: ToolStubsOptions) {
    this.opts = opts;
  }

  /** The tools currently offered, in manifest order. */
  names(): string[] {
    return [...this.manifest.keys()];
  }

  entry(name: string): ToolManifestEntry | undefined {
    return this.manifest.get(name);
  }

  /** Takes the manifest from a (re)register and applies it to every live session for its next turn. */
  update(tools: readonly ToolManifestEntry[]): void {
    const next = new Map<string, ToolManifestEntry>();
    for (const t of tools) {
      if (!KNOWN_PROXIED_TOOLS.includes(t.name)) {
        log.warn({ tool: t.name }, "bot offers a tool this workspace can't register; update the workspace to use it");
        continue;
      }
      next.set(t.name, t);
    }
    this.manifest = next;
    for (const b of [...this.bindings]) {
      if (!b.sync()) this.bindings.delete(b);
    }
  }

  /** Pi tool definitions for the current manifest, calling as `ctx`. */
  definitions(ctx: StubAgentContext = MAIN_AGENT): ToolDefinition[] {
    return [...this.manifest.values()].map((e) => this.definition(e, ctx));
  }

  /** A per-session hook: its extension factory registers the stubs and keeps them in step with update(). */
  binding(ctx: StubAgentContext = MAIN_AGENT): StubBinding {
    const b = new StubBinding(this, ctx);
    this.bindings.add(b);
    return b;
  }

  /** (Re)subscribes a binding to update(); its factory calls this on every load, reloads included. */
  attach(b: StubBinding): void {
    this.bindings.add(b);
  }

  /** Stops updating a binding, for a session that was disposed or never finished being created. */
  release(b: StubBinding): void {
    this.bindings.delete(b);
  }

  definition(entry: ToolManifestEntry, ctx: StubAgentContext): ToolDefinition {
    const def: ToolDefinition = {
      name: entry.name,
      label: entry.name,
      description: entry.description,
      promptSnippet: `${entry.name}: runs through the bot${entry.approval === "ask" ? " and needs drk's approval in chat" : ""}`,
      parameters: entry.inputSchema as ToolDefinition["parameters"],
      execute: (_toolCallId, params, signal) => this.call(entry.name, params, ctx, signal),
    };
    return def;
  }

  // Pi has already validated (and coerced) params against the closed schema; they go to the bot as Pi left them.
  private async call(name: string, args: unknown, ctx: StubAgentContext, signal: AbortSignal | undefined): Promise<StubResult> {
    const entry = this.manifest.get(name);
    if (!entry) throw new Error(`${name} is no longer offered by the bot`);
    const callId = (this.opts.newId ?? ulid)();
    const params: ToolCallParams = {
      principalId: this.opts.principalId,
      callId,
      name,
      args,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
      ...(ctx.origin ? { origin: ctx.origin } : {}),
    };
    if (signal?.aborted) throw new Error(`${name} was aborted before it was sent`);
    const pending = this.opts.request(RPC_METHODS.toolCall, params, toolTimeoutMs(entry.approval));
    let raw: unknown;
    try {
      raw = await (signal ? abortable(pending, signal) : pending);
    } catch (err) {
      if (signal?.aborted) this.cancel(callId);
      throw new Error(requestErrorText(err, entry));
    }
    const result = raw as ToolCallResult | undefined;
    if (result?.ok === true && typeof result.result === "string") {
      return { content: [{ type: "text", text: result.result }], details: { callId } };
    }
    if (result?.ok === false && result.denied) throw new Error(DENIED_TEXT);
    if (result?.ok === false && typeof result.error === "string") throw new Error(result.error);
    throw new Error(`malformed tool/call result for ${name}`);
  }

  /** Withdraws a call whose turn was stopped, so its approval prompt can't run it later. Best-effort: the
   *  prompt still expires on its own if this never arrives. */
  private cancel(callId: string): void {
    const params: ToolCancelParams = { principalId: this.opts.principalId, callId };
    let sent: Promise<unknown>;
    try {
      sent = this.opts.request(RPC_METHODS.toolCancel, params, TOOL_CANCEL_TIMEOUT_MS);
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.catch((err) => log.debug({ err, callId }, "tool/cancel not delivered"));
  }
}

/** The stubs registered into one Pi session; the session's extension runtime is replaced on reload. */
export class StubBinding {
  private pi: ExtensionAPI | null = null;
  private registered = new Map<string, { def: ToolDefinition; key: string; hidden: boolean }>();

  constructor(
    private readonly stubs: ToolStubs,
    readonly ctx: StubAgentContext,
  ) {}

  /** Pass to the session's resource loader; runs at every load, including session.reload(). */
  readonly factory: ExtensionFactory = (pi) => {
    this.pi = pi;
    this.registered = new Map();
    // An update() during a reload found the old runtime stale and dropped this binding.
    this.stubs.attach(this);
    this.sync();
  };

  release(): void {
    this.pi = null;
    this.stubs.release(this);
  }

  /** Stub names registered and declared to the model. */
  offered(): string[] {
    return [...this.registered].filter(([, r]) => !r.hidden).map(([n]) => n);
  }

  /** Every stub name the session holds, hidden ones included. */
  registeredNames(): string[] {
    return [...this.registered.keys()];
  }

  /** Throws unless each offered name resolves to this binding's own definition, not a same-named tool from
   *  another extension. `only` limits the check to the stubs a tool allowlist let into the session. */
  assertOwned(session: Pick<AgentSession, "getToolDefinition" | "dispose">, label: string, only?: readonly string[]): void {
    for (const [name, r] of this.registered) {
      if (only && !only.includes(name)) continue;
      if (session.getToolDefinition(name) === r.def) continue;
      session.dispose();
      throw new Error(`${label}: pi tool ${name} is not the bot-proxied stub`);
    }
  }

  /** Registers added or changed stubs and hides removed ones. False once the session's runtime is stale
   *  (disposed, or mid-reload; a reload's factory run attaches it again). */
  sync(): boolean {
    const pi = this.pi;
    if (!pi) return true;
    const want = new Map(this.stubs.names().map((n) => [n, this.stubs.entry(n)!]));
    try {
      for (const [name, entry] of want) {
        const key = JSON.stringify([entry.description, entry.inputSchema, entry.approval]);
        const have = this.registered.get(name);
        if (have && !have.hidden && have.key === key) continue;
        const def = this.stubs.definition(entry, this.ctx);
        pi.registerTool(def);
        this.registered.set(name, { def, key, hidden: false });
      }
      for (const [name, r] of this.registered) {
        if (want.has(name) || r.hidden) continue;
        // Pi has no unregister; a hidden tool is left out of the model's tool set.
        const def: ToolDefinition = { ...r.def, exposure: "hidden" };
        pi.registerTool(def);
        this.registered.set(name, { def, key: "", hidden: true });
      }
      return true;
    } catch (err) {
      if (err instanceof Error && STALE_RUNTIME_RE.test(err.message)) {
        log.debug({ err }, "dropping a stale tool-stub binding");
        this.pi = null;
        return false;
      }
      log.warn({ err }, "failed to apply the tool manifest to a session; keeping it for the next update");
      return true;
    }
  }
}

// Pi's registerTool error once the session is disposed or reloaded past this runtime.
const STALE_RUNTIME_RE = /extension ctx is stale/;

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function requestErrorText(err: unknown, entry: ToolManifestEntry): string {
  if (err instanceof NotConnectedError) return "workspace link is down; the call was not sent";
  if (err instanceof ConnectionClosedError) return LINK_CLOSED_TEXT;
  if (err instanceof RequestTimeoutError) return `${entry.name}: no answer from the bot within ${Math.round(err.timeoutMs / 1000)} s; it may still complete, so check before retrying`;
  if (err instanceof Error && err.message === "aborted") return `${entry.name} was aborted; the bot may still complete it, so check before retrying`;
  return err instanceof Error ? err.message : String(err);
}
