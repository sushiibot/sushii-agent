// Concrete HookBus (contracts.ts §6). A surface wires this once per process and passes it into
// AgentCoreDeps; the loop dispatcher (loop.ts's fireHook) only ever calls `.emit`.
import type { HookBus, HookEvents, HookName } from "./contracts.ts";

export function createHookBus(): HookBus {
  const handlers = new Map<HookName, ((...args: unknown[]) => void)[]>();

  return {
    on<E extends HookName>(event: E, handler: HookEvents[E]): void {
      const list = handlers.get(event) ?? [];
      list.push(handler as (...args: unknown[]) => void);
      handlers.set(event, list);
    },
    emit<E extends HookName>(event: E, ...args: Parameters<HookEvents[E]>): void {
      for (const handler of handlers.get(event) ?? []) {
        try {
          handler(...args);
        } catch {
          // Observational tier — a throwing hook must never break the turn.
        }
      }
    },
  };
}
