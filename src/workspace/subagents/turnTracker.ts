import { RPC_METHODS, type ChatEventParams, type ChatOrigin } from "../../orchestration/contracts.ts";

export interface ParentTurn {
  turnId: string;
  origin?: ChatOrigin;
}

/** Follows the main agent's chat/event stream, so subagent progress can nest under the turn that spawned it. */
export class MainTurnTracker {
  private turn: ParentTurn | null = null;
  private readonly turns = new Map<string, ParentTurn>();

  /** Call with every outgoing notify. */
  observe(method: string, params: unknown): void {
    if (method !== RPC_METHODS.chatEvent) return;
    const p = params as ChatEventParams;
    if (p?.agentId !== "main") return;
    if (p.ev.type === "turn_start") { this.turn = { turnId: p.turnId, ...(p.origin ? { origin: p.origin } : {}) }; this.turns.set(p.turnId, this.turn); }
    else if (p.ev.type === "turn_end") { this.turns.delete(p.turnId); if (this.turn?.turnId === p.turnId) this.turn = null; }
  }

  get(turnId: string): ParentTurn | null { return this.turns.get(turnId) ?? null; }

  current(): ParentTurn | null {
    return this.turn;
  }
}
