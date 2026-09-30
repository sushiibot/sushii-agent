// Personal-agent workspace wiring shared by every surface: the surface registry, the proxied tools, the link
// and its orchestration server. Surfaces contribute adapters; index.ts registers them all before listen.
import type { ConversationStore, SpaceMemoryStore, ToolRegistry } from "../../core/contracts.ts";
import type { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { getLogger } from "../../logger.ts";
import { isVerifiedWebActor, normalizeLogin, WEB_SURFACE } from "../../surfaces/web/actor.ts";
import { tokenProviderFromEnv } from "../github/githubApp.ts";
import { resolvePrincipal } from "../principals.ts";
import { OrchestrationServer, type SecretGrant } from "../transport/server.ts";
import { DEFAULT_BOT_IDENTITY, GitHubTokenBroker } from "./githubToken.ts";
import { WorkspaceLink } from "./link.ts";
import type { Timers } from "./progress.ts";
import { SurfaceRegistry, type SurfaceActor, type SurfaceAdapter } from "./surface.ts";
import { WorkspaceTools } from "./tools.ts";

const log = getLogger("orchestration/workspace/boot");

const DISCORD = "discord";
/** Private space the proxied tools run in, the one the in-process DM agent uses. */
export const WORKSPACE_TOOL_SPACE = { surface: DISCORD, spaceId: "dm" } as const;
const OUTBOX_PRUNE_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceConfig {
  principalId: string;
  /** WORKSPACE_PREFERRED_SURFACE. `web` pins every personal delivery, ask and approval to web. */
  preferredSurface: string;
  /** DM_WORKSPACE_ENABLED: gates the tool manifest and the GitHub broker, for every surface. */
  enabled: boolean;
  orchPort: number;
  ownerDiscordId: string | undefined;
  /** WEB_OWNER_LOGIN, only to check at boot that principals.json maps it to the owner. */
  webOwnerLogin?: string;
  store: ConversationStore;
  memory: SpaceMemoryStore;
  linkStore: WorkspaceLinkStore;
  /** Default: built from GITHUB_APP_* and GITHUB_BOT_* in the environment. */
  github?: Pick<GitHubTokenBroker, "handle">;
  secretGrants?: Record<string, SecretGrant>;
  registry?: ToolRegistry;
  timers?: Timers;
  now?: () => number;
}

export interface WorkspaceBoot {
  registry: SurfaceRegistry;
  tools: WorkspaceTools;
  link: WorkspaceLink;
  server: OrchestrationServer;
}

/**
 * Who may act as the workspace's principal. Discord: the configured owner id. Web: only an actor the web
 * gateway minted from a verified login, and only when principals.json maps that login to this principal
 * as its owner. Every other surface: nobody.
 */
export function workspaceOwnerCheck(o: { principalId: string; ownerDiscordId: string | undefined }): (actor: SurfaceActor) => boolean {
  return (actor) => {
    if (actor.surface === DISCORD) return !!o.ownerDiscordId && actor.userId === o.ownerDiscordId;
    if (actor.surface === WEB_SURFACE) {
      if (!isVerifiedWebActor(actor)) return false;
      const principal = resolvePrincipal(WEB_SURFACE, normalizeLogin(actor.userId));
      return principal?.isOwner === true && principal.principalId === o.principalId;
    }
    return false;
  };
}

/** Builds the registry, tools, link and server with `adapters` registered. Does not listen: index.ts
 *  registers late adapters (web) first, then calls listenWorkspace. */
export function bootWorkspace(cfg: WorkspaceConfig, adapters: SurfaceAdapter<any, any>[]): WorkspaceBoot {
  const preferred = cfg.preferredSurface.trim().toLowerCase();
  const registry = new SurfaceRegistry(preferred, { pinned: preferred === WEB_SURFACE });
  for (const adapter of adapters) registry.register(adapter);
  checkWebOwnerMapping(cfg);

  const isOwner = workspaceOwnerCheck({ principalId: cfg.principalId, ownerDiscordId: cfg.ownerDiscordId });
  const tools = new WorkspaceTools({
    principalId: cfg.principalId,
    ownerUserId: () => cfg.ownerDiscordId,
    toolSpace: WORKSPACE_TOOL_SPACE,
    surfaces: registry,
    isOwner,
    store: cfg.store,
    memory: cfg.memory,
    ...(cfg.registry ? { registry: cfg.registry } : {}),
    ...(cfg.timers ? { timers: cfg.timers } : {}),
    ...(cfg.now ? { now: cfg.now } : {}),
  });
  const link = new WorkspaceLink({
    principalId: cfg.principalId,
    store: cfg.linkStore,
    surfaces: registry,
    owner: () => ({ id: cfg.ownerDiscordId ?? "", name: "owner" }),
    isOwner,
    tools,
    enabled: cfg.enabled,
    github: cfg.github ?? githubBrokerFromEnv(cfg.principalId),
    ...(cfg.timers ? { timers: cfg.timers } : {}),
    ...(cfg.now ? { now: cfg.now } : {}),
  });
  const server = new OrchestrationServer({ port: cfg.orchPort, ...(cfg.secretGrants ? { secretGrants: cfg.secretGrants } : {}) });
  // Attached even with DM_WORKSPACE_ENABLED off, so a workspace's leftover outbox drains instead of resending forever.
  link.attach(server);
  return { registry, tools, link, server };
}

/**
 * Starts the workspace transport once every adapter is registered, so a workspace that registers at once
 * doesn't drain its outbox into a missing surface. Never throws: a missing preferred surface holds personal
 * approvals and deliveries, and a bind failure disables only the link; guild features keep running.
 */
export function listenWorkspace(boot: WorkspaceBoot, port: number): void {
  if (!boot.registry.hasPreferred()) {
    log.error(
      { preferred: boot.registry.preferredSurface, registered: boot.registry.registered() },
      "the preferred workspace surface has no adapter; personal approvals are held then denied, and deliveries wait until it is back",
    );
  }
  try {
    boot.server.listen();
    log.info({ port }, "workspace transport listening");
  } catch (err) {
    log.error({ err, port }, "workspace transport failed to listen; the personal-agent link is disabled");
  }
  boot.link.pruneOutboxSeen();
  setInterval(() => boot.link.pruneOutboxSeen(), OUTBOX_PRUNE_MS).unref?.();
}

function checkWebOwnerMapping(cfg: WorkspaceConfig): void {
  if (!cfg.webOwnerLogin?.trim()) return;
  const principal = resolvePrincipal(WEB_SURFACE, normalizeLogin(cfg.webOwnerLogin));
  if (principal?.isOwner && principal.principalId === cfg.principalId) return;
  log.error(
    { principalId: cfg.principalId },
    `principals.json has no "${WEB_SURFACE}" identity for WEB_OWNER_LOGIN on the owner principal; web approvals and asks will be refused`,
  );
}

function githubBrokerFromEnv(principalId: string): GitHubTokenBroker {
  return new GitHubTokenBroker({
    principalId,
    provider: tokenProviderFromEnv(),
    bot: {
      name: process.env.GITHUB_BOT_NAME || DEFAULT_BOT_IDENTITY.name,
      email: process.env.GITHUB_BOT_EMAIL || DEFAULT_BOT_IDENTITY.email,
    },
  });
}
