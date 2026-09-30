import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";

export const WEB_SURFACE = "web";

// Checked by object identity, not shape. A look-alike or a spread copy of a minted actor never passes.
const minted = new WeakSet<SurfaceActor>();

export const normalizeLogin = (s: string) => s.trim().toLowerCase();

/** The web actor for a login the gateway has already verified. Only createWebHandler may call this. */
export function mintWebActor(login: string, name?: string): SurfaceActor {
  const userId = normalizeLogin(login);
  const actor: SurfaceActor = Object.freeze({ surface: WEB_SURFACE, userId, name: name?.trim() || userId });
  minted.add(actor);
  return actor;
}

export function isVerifiedWebActor(actor: SurfaceActor): boolean {
  return minted.has(actor);
}
