import { generateText } from "ai";
import type {
  AgentCore,
  AgentCoreDeps,
  AgentTurnResult,
  AuthorRef,
  CancelOutcome,
  ConversationRef,
  InboundMessage,
  MemoryProvider,
  PendingInteraction,
  SurfaceSession,
  ToolContext,
  TurnEndContext,
  TurnResumption,
} from "./contracts.ts";
import { conversationKey } from "./contracts.ts";
import { buildUserNote, formatResumptionAsUserTurn } from "./prompt.ts";
import { assembleSystemPrompt } from "./systemPrompt.ts";
import { MEMORY_LIMIT, CORE_PROFILE_TITLE } from "./stores/index.ts";
import { fireHook, runLoop } from "./loop.ts";

function sameAuthor(a: AuthorRef, b: AuthorRef): boolean {
  return a.surface === b.surface && a.userId === b.userId;
}

/** Hard cap on how long per-turn memory retrieval may delay a reply. Memory is best-effort: if the
 *  provider (embedding + store round-trip) doesn't resolve in time, we inject nothing rather than
 *  block. The provider also gets this as `deadlineMs` so it can self-bound; the race is the backstop. */
const MEMORY_RETRIEVE_DEADLINE_MS = 1500;

async function raceMemoryRetrieve(provider: MemoryProvider, spaceId: string, query: string): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), MEMORY_RETRIEVE_DEADLINE_MS));
  try {
    return await Promise.race([
      provider.retrieve({ spaceId, query, deadlineMs: MEMORY_RETRIEVE_DEADLINE_MS }),
      timeout,
    ]);
  } catch {
    return null; // a failing provider must never break a turn
  }
}

/** Per-conversation runtime bookkeeping — never persisted. `initiator` gates `cancel()`; `owner`
 *  is the tool-facing identity, permanently nulled by mid-loop tainting (C-§3). Keeping the two
 *  separate means a tainted turn is still stoppable by whoever actually started it. */
interface ActiveTurn {
  initiator: AuthorRef;
  owner: AuthorRef | null;
  knownUsers: Map<string, AuthorRef>;
  cancelRequested: boolean;
  queue: InboundMessage[];
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const activeTurns = new Map<string, ActiveTurn>();
  const toModel = (model: AgentCoreDeps["model"]) => model as unknown as Parameters<typeof generateText>[0]["model"];
  const limits = deps.limits ?? { maxIterations: 30, contextRatio: 0.85 };

  function drainQueue(turn: ActiveTurn) {
    return () => {
      if (turn.queue.length === 0) return [];
      const batch = turn.queue;
      turn.queue = [];
      // onConsumed fires as each queued (mid-loop) message is actually injected — this is what
      // clears its ⏳ and adds ✅ on the Discord surface. The first message of a turn is NOT a
      // consume event (it was never queued), so it gets no reaction, matching the old path.
      return batch.map((inbound) => {
        fireHook(deps.hooks, "onConsumed", { conversation: inbound.conversation, inbound });
        return { author: inbound.author, text: inbound.text };
      });
    };
  }

  async function runTurn(
    conversation: ConversationRef,
    turn: ActiveTurn,
    session: SurfaceSession,
    firstUserText: string,
    initialMentions: AuthorRef[] | undefined,
    autoMod: boolean,
  ): Promise<AgentTurnResult> {
    const data = deps.store.load(conversation);
    let messages = [...data.messages];

    // Compaction runs on the persisted history BEFORE the new user turn is appended (fold old,
    // then continue). No-op unless a Compactor is wired. Persisted immediately so the fold is
    // durable and the prompt prefix stays stable until the next fold.
    if (deps.compactor) {
      const outcome = await deps.compactor.maybeCompact({ messages, contextLimit: deps.model.contextLimit });
      if (outcome.compacted) {
        messages = outcome.messages;
        deps.store.save(conversation, { messages, initialThreadContext: data.initialThreadContext ?? null });
        // outcome.factCandidates → deps.memoryProvider.remember is the compaction-as-deriver hook,
        // wired in the compaction↔memory follow-up unit.
      }
    }

    for (const author of initialMentions ?? []) {
      if (!turn.knownUsers.has(author.userId)) turn.knownUsers.set(author.userId, author);
    }
    if (initialMentions?.length) {
      messages.push({ role: "system", content: buildUserNote(initialMentions) });
    }
    messages.push({ role: "user", content: firstUserText });

    // C8: core owns slot ORDER; the surface fills per-turn content via promptContext(). The
    // triggering-user section is suppressed for the autonomous auto-mod driver — it has no
    // requesting user, matching the old dispatch.ts path that passed no triggeringUser.
    const pc = session.promptContext?.() ?? {};

    // Proactive memory: retrieve a durable-fact block keyed to this turn's user text, injected into
    // the system prompt. Best-effort + time-bounded (raceMemoryRetrieve), no-op unless wired.
    const memoryBlock = deps.memoryProvider
      ? (await raceMemoryRetrieve(deps.memoryProvider, conversation.spaceId, firstUserText)) ?? undefined
      : undefined;

    const systemPrompt = assembleSystemPrompt({
      behavior: deps.behavior,
      selfId: session.selfId,
      selfName: session.selfName,
      channel: pc.channel,
      author: autoMod ? undefined : turn.initiator,
      ownerSection: pc.ownerSection,
      serverContext: deps.memory.getServerContext(conversation.spaceId),
      coreProfile: deps.memory.read(conversation.spaceId, CORE_PROFILE_TITLE)?.content ?? undefined,
      memoryIndex: deps.memory.listTitles(conversation.spaceId).filter((t) => t !== CORE_PROFILE_TITLE),
      memoryCount: deps.memory.count(conversation.spaceId),
      memoryLimit: MEMORY_LIMIT,
      emojiMap: pc.emojiMap,
      threadContext: pc.threadContext,
      threadChannelId: pc.threadChannelId,
      moduleExtras: pc.moduleExtras,
    });

    const toolEntries = deps.tools.resolve(session, { surface: conversation.surface, spaceId: conversation.spaceId, autoMod });

    const toolContextBase: Omit<ToolContext, "owner"> = {
      space: { surface: conversation.surface, spaceId: conversation.spaceId },
      store: deps.store,
      memory: deps.memory,
      log: undefined,
      ...session.hosts,
    };

    fireHook(deps.hooks, "onTurnStart", { conversation, author: turn.initiator });

    const result = await runLoop(messages, {
      model: deps.model,
      toModel,
      toolEntries,
      interceptors: deps.interceptors,
      hooks: deps.hooks,
      contextRatio: limits.contextRatio,
      maxIterations: limits.maxIterations,
    }, {
      conversation,
      owner: turn.owner,
      knownUsers: turn.knownUsers,
      toolContextBase,
      systemPrompt,
      memoryBlock,
      dequeue: drainQueue(turn),
      isCancelled: () => turn.cancelRequested || !!session.isCancelled?.(),
      onInterim: async (reply) => {
        fireHook(deps.hooks, "onInterim", { conversation, reply });
        await session.deliver(reply);
      },
      onToolsDispatched: (tools) => {
        fireHook(deps.hooks, "onToolsDispatched", { conversation, tools });
      },
    });

    turn.owner = result.owner;
    if (result.resetRequested) {
      // reset_conversation tool ran: clear this conversation's stored history (durable memory is
      // untouched). Applied here, after the turn, so it isn't clobbered by the normal save below.
      deps.store.save(conversation, { messages: [], initialThreadContext: null });
    } else {
      // Freeze the surface's first-turn fetched context: once stored it's reused verbatim (stable
      // prompt prefix, C11). Ports the old saveConversation, which persisted the turn's threadContext.
      deps.store.save(conversation, {
        messages: result.messages,
        initialThreadContext: data.initialThreadContext ?? pc.threadContext ?? null,
      });
    }

    if (result.cancelled) {
      fireHook(deps.hooks, "onCancelled", { conversation });
      return { status: "cancelled" };
    }

    if (result.pending) {
      if (session.presentInteraction) await session.presentInteraction(result.pending);
      fireHook(deps.hooks, "onPaused", { conversation, pending: result.pending });
      return { status: "paused", pending: result.pending };
    }

    await session.deliver(result.reply);

    const turnEndCtx: TurnEndContext = {
      conversation,
      reply: result.reply,
      toolUseCount: result.messages.filter((m) => m.role === "tool").length,
      userTurnCount: result.messages.filter((m) => m.role === "user").length,
      history: result.messages,
    };
    fireHook(deps.hooks, "onTurnEnd", turnEndCtx);

    return { status: "completed", reply: result.reply };
  }

  return {
    async handleInbound(inbound: InboundMessage, session: SurfaceSession): Promise<AgentTurnResult> {
      const key = conversationKey(inbound.conversation);
      const active = activeTurns.get(key);
      if (active) {
        active.queue.push(inbound);
        fireHook(deps.hooks, "onQueued", { conversation: inbound.conversation, inbound });
        return { status: "queued" };
      }

      const turn: ActiveTurn = {
        initiator: inbound.author,
        owner: inbound.author,
        knownUsers: new Map(),
        cancelRequested: false,
        queue: [],
      };
      activeTurns.set(key, turn);
      try {
        const autoMod = inbound.platform?.surface === "discord" && !!inbound.platform.autoModTrigger;
        return await runTurn(
          inbound.conversation,
          turn,
          session,
          inbound.text,
          inbound.mentionedUsers,
          autoMod,
        );
      } catch (err) {
        return { status: "error", message: err instanceof Error ? err.message : String(err) };
      } finally {
        activeTurns.delete(key);
      }
    },

    async resume(conversation: ConversationRef, resumption: TurnResumption, session: SurfaceSession): Promise<AgentTurnResult> {
      const key = conversationKey(conversation);
      if (activeTurns.has(key)) {
        return { status: "error", message: "a turn is already active for this conversation" };
      }

      const turn: ActiveTurn = {
        initiator: resumption.by,
        owner: resumption.by,
        knownUsers: new Map(),
        cancelRequested: false,
        queue: [],
      };
      activeTurns.set(key, turn);
      try {
        // A resumed turn is always a human-driven continuation (button click), never the
        // autonomous auto-mod driver itself — pausing tools (ask_question, keyword approvals)
        // aren't in AUTO_MOD_ONLY_TOOLS, so this can't strand a paused auto-mod turn.
        return await runTurn(conversation, turn, session, formatResumptionAsUserTurn(resumption), undefined, false);
      } catch (err) {
        return { status: "error", message: err instanceof Error ? err.message : String(err) };
      } finally {
        activeTurns.delete(key);
      }
    },

    cancel(conversation: ConversationRef, byAuthor: AuthorRef): CancelOutcome {
      const key = conversationKey(conversation);
      const turn = activeTurns.get(key);
      if (!turn) return { status: "no-active-turn" };
      if (!sameAuthor(turn.initiator, byAuthor)) return { status: "forbidden", owner: turn.initiator };
      turn.cancelRequested = true;
      return { status: "cancelling" };
    },
  };
}

export type { PendingInteraction };
