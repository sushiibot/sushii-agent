import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";

export const WEB_SURFACE = "web";

// Identity, not shape: an actor counts as verified only if it is the very object minted here, so a
// `{surface:"web"}` built anywhere else, or a spread copy of a minted one, never passes.
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
