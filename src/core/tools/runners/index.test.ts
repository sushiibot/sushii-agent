import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthorRef, SurfaceCapabilities, SurfaceSession, ToolContext, ToolHosts } from "../../contracts.ts";

// mock.module must replace the dispatcher module before runners/index.ts's own import binds —
// this proves the COMPOSED path (ctx.owner/ctx.space -> principalOf/spaceOf -> can()), not just
// authz.can() in isolation. AuthzError/DispatcherUnavailableError are re-exported unchanged so
// `instanceof` checks in index.ts still work against the real classes.
class FakeDispatcher {
  ensureListening(): void {}
  isRunnerLive(): boolean {
    return true;
  }
  async dispatch(input: { principal: string; runnerId: string }): Promise<{ id: string; nativeSessionId: string }> {
    return { id: "task-1", nativeSessionId: `native-${input.principal}` };
  }
  selectRunner(): { runnerId: string; viaPref: boolean } {
    return { runnerId: "cloud", viaPref: false };
  }
  recordRoutingChoice(): void {}
  listRunning(): unknown[] {
    return [];
  }
  readTask(): undefined {
    return undefined;
  }
  async resume(input: { principal: string; taskId: string }): Promise<{ id: string; status: string }> {
    return { id: input.taskId, status: "running" };
  }
}
const fakeDispatcher = new FakeDispatcher();
let dispatcherUnavailable = false;

mock.module("../../../orchestration/dispatcher.ts", () => {
  const actual = require("../../../orchestration/dispatcher.ts");
  return {
    ...actual,
    getDispatcher: () => {
      if (dispatcherUnavailable) throw new actual.DispatcherUnavailableError("orchestration dispatcher failed to start");
      return fakeDispatcher;
    },
  };
});

const { dispatchToRunnerEntry, listRunningSessionsEntry, readSessionEntry, resumeSessionEntry, RUNNER_TOOL_ENTRIES, parseRepoSpec } = await import("./index.ts");

describe("parseRepoSpec", () => {
  test("accepts owner/name and GitHub URLs, rejects malformed input", () => {
    expect(parseRepoSpec("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseRepoSpec("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseRepoSpec("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseRepoSpec("acme")).toBeNull();
    expect(parseRepoSpec("acme/widgets/extra")).toBeNull();
    expect(parseRepoSpec("acme/../etc")).toBeNull();
    expect(parseRepoSpec("")).toBeNull();
  });
});
const { config } = await import("../../../config.ts");
const { _resetParkedDispatches } = await import("./confirmGate.ts");
const { createToolRegistry } = await import("../registry.ts");

const OWNER = "owner-1";
const DM_SPACE = { surface: "discord", spaceId: "dm" };
const GUILD_SPACE = { surface: "discord", spaceId: "guild-1" };
const DENIED = "This tool is unavailable in this space.";

function author(userId: string): AuthorRef {
  return { surface: "discord", userId, username: userId };
}

const ALL_CAPS: SurfaceCapabilities = {
  richComponents: true,
  customEmoji: true,
  nativeTimestamps: true,
  threads: true,
  reactions: true,
  progress: true,
  interactiveChoices: true,
  typing: true,
  replyTo: true,
};

function fakeSession(hosts: ToolHosts = {}): SurfaceSession {
  return {
    capabilities: ALL_CAPS,
    renderer: { renderText: (text) => text, promptGuidance: () => ({ sections: {} }), describeUser: () => "user" },
    selfId: "bot",
    selfName: "bot",
    deliver: async () => ({}),
    hosts,
  };
}

function ctx(space: { surface: string; spaceId: string }, owner: AuthorRef | null): ToolContext {
  return {
    space,
    owner,
    store: {} as never,
    memory: {} as never,
    log: {} as never,
  };
}

describe("runner tools authz wiring (composed path: ctx -> principalOf/spaceOf -> can())", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;

  beforeEach(() => {
    config.ownerDiscordId = OWNER;
    config.principals = {}; // legacy regime — an empty registry falls back to the ownerDiscordId gate
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
  });

  test("dispatch_to_runner: denied in a guild space", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      ctx(GUILD_SPACE, author(OWNER)),
    );
    expect(result.content).toBe(DENIED);
  });

  test("dispatch_to_runner: allowed for the owner in a personal space", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      ctx(DM_SPACE, author(OWNER)),
    );
    expect(result.content).toContain("Dispatched task task-1");
  });

  test("dispatch_to_runner: denied for a non-owner even in a personal space", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      ctx(DM_SPACE, author("not-the-owner")),
    );
    expect(result.content).toBe(DENIED);
  });

  test("dispatch_to_runner: denied with no authenticated owner identity for the turn", async () => {
    const result = await dispatchToRunnerEntry.execute({ runner_id: "r1", cwd: "/tmp", prompt: "go" }, ctx(DM_SPACE, null));
    expect(result.content).toBe(DENIED);
  });

  test("list_running_sessions: denied in a guild space, allowed in a personal space", async () => {
    expect((await listRunningSessionsEntry.execute({}, ctx(GUILD_SPACE, author(OWNER)))).content).toBe(DENIED);
    expect((await listRunningSessionsEntry.execute({}, ctx(DM_SPACE, author(OWNER)))).content).toBe("(no running sessions)");
  });

  test("list_running_sessions: denied for a non-owner in a personal space", async () => {
    expect((await listRunningSessionsEntry.execute({}, ctx(DM_SPACE, author("not-the-owner")))).content).toBe(DENIED);
  });

  test("read_session: denied in a guild space, allowed (past authz) in a personal space", async () => {
    expect((await readSessionEntry.execute({ task_id: "t1" }, ctx(GUILD_SPACE, author(OWNER)))).content).toBe(DENIED);
    expect((await readSessionEntry.execute({ task_id: "t1" }, ctx(DM_SPACE, author(OWNER)))).content).toBe("No such task: t1");
  });

  test("read_session: denied for a non-owner in a personal space", async () => {
    expect((await readSessionEntry.execute({ task_id: "t1" }, ctx(DM_SPACE, author("not-the-owner")))).content).toBe(DENIED);
  });

  test("resume_session: denied in a guild space, allowed in a personal space", async () => {
    expect((await resumeSessionEntry.execute({ task_id: "t1", prompt: "go on" }, ctx(GUILD_SPACE, author(OWNER)))).content).toBe(DENIED);
    const result = await resumeSessionEntry.execute({ task_id: "t1", prompt: "go on" }, ctx(DM_SPACE, author(OWNER)));
    expect(result.content).toContain("Resumed task t1");
  });

  test("resume_session: denied for a non-owner in a personal space", async () => {
    expect((await resumeSessionEntry.execute({ task_id: "t1", prompt: "go on" }, ctx(DM_SPACE, author("not-the-owner")))).content).toBe(DENIED);
  });
});

describe("runner tools authz wiring — CONFIGURED registry (principal + isPrivate)", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;
  const DRK_SLACK = "U0OWNERTEST0";
  const SLACK_DM = { surface: "slack", spaceId: "T0AAA" };

  beforeEach(() => {
    config.ownerDiscordId = undefined; // registry is the sole owner source
    config.principals = { drk: { owner: true, identities: { slack: DRK_SLACK } } };
  });
  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
  });

  function slackAuthor(userId: string): AuthorRef {
    return { surface: "slack", userId, username: userId };
  }
  function privCtx(space: { surface: string; spaceId: string }, owner: AuthorRef | null, isPrivate: boolean): ToolContext {
    return { space, isPrivate, owner, store: {} as never, memory: {} as never, log: {} as never };
  }

  test("owner principal in a private Slack DM dispatches (no legacy ownerDiscordId needed)", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      privCtx(SLACK_DM, slackAuthor(DRK_SLACK), true),
    );
    expect(result.content).toContain("Dispatched task task-1");
  });

  test("owner principal in a NON-private Slack channel dispatches (runner tools are owner-only, not DM-only)", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      privCtx({ surface: "slack", spaceId: "C-pub" }, slackAuthor(DRK_SLACK), false),
    );
    expect(result.content).toContain("Dispatched task task-1");
  });

  test("a NON-owner in a NON-private Slack channel is denied", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      privCtx({ surface: "slack", spaceId: "C-pub" }, slackAuthor("someone-else"), false),
    );
    expect(result.content).toBe(DENIED);
  });

  test("a non-owner (unlinked) id in a private Slack DM is denied", async () => {
    const result = await dispatchToRunnerEntry.execute(
      { runner_id: "r1", cwd: "/tmp", prompt: "go" },
      privCtx(SLACK_DM, slackAuthor("someone-else"), true),
    );
    expect(result.content).toBe(DENIED);
  });
});

describe("runner tools: dispatcher unavailable (getDispatcher listen failure)", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;

  beforeEach(() => {
    config.ownerDiscordId = OWNER;
    config.principals = {};
    dispatcherUnavailable = true;
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
    dispatcherUnavailable = false;
  });

  test("dispatch_to_runner returns a clean 'unavailable' message instead of throwing", async () => {
    const result = await dispatchToRunnerEntry.execute({ runner_id: "r1", cwd: "/tmp", prompt: "go" }, ctx(DM_SPACE, author(OWNER)));
    expect(result.content).toBe("Runner orchestration is unavailable right now.");
  });

  test("list_running_sessions returns a clean 'unavailable' message instead of throwing", async () => {
    const result = await listRunningSessionsEntry.execute({}, ctx(DM_SPACE, author(OWNER)));
    expect(result.content).toBe("Runner orchestration is unavailable right now.");
  });

  test("read_session returns a clean 'unavailable' message instead of throwing", async () => {
    const result = await readSessionEntry.execute({ task_id: "t1" }, ctx(DM_SPACE, author(OWNER)));
    expect(result.content).toBe("Runner orchestration is unavailable right now.");
  });

  test("resume_session returns a clean 'unavailable' message instead of throwing", async () => {
    const result = await resumeSessionEntry.execute({ task_id: "t1", prompt: "go on" }, ctx(DM_SPACE, author(OWNER)));
    expect(result.content).toBe("Runner orchestration is unavailable right now.");
  });
});

describe("runner tools: registry-level availability gate (mirrors ops-triage)", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;

  beforeEach(() => {
    config.principals = {}; // legacy regime: gating falls back to owner-availability + isPersonalSpace
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
  });

  function names(owner: boolean, spaceId: string): string[] {
    const registry = createToolRegistry(RUNNER_TOOL_ENTRIES, () => ({ exa: true, owner, grafanaBaseUrl: true, linear: true }));
    return registry.resolve(fakeSession(), { surface: "discord", spaceId }).map((e) => e.name);
  }

  test("hidden in a guild space even with an owner configured", () => {
    expect(names(true, "guild-1")).toEqual([]);
  });

  test("offered in a personal/DM space with an owner configured", () => {
    expect(names(true, "dm")).toEqual(["dispatch_to_runner", "list_runners", "list_running_sessions", "read_session", "resume_session", "stop_task", "discard_task", "steer_task"]);
  });

  test("hidden in a personal/DM space when no owner is configured", () => {
    expect(names(false, "dm")).toEqual([]);
  });
});

describe("dispatch_to_runner: confirm-before-dispatch for non-owner members", () => {
  const prevOwner = config.ownerDiscordId;
  const prevPrincipals = config.principals;
  const prevCommunities = config.communities;
  const DRK = "111";
  const MEMBER = "222";
  const GUILD = { surface: "discord", spaceId: "dc-guild" };
  const args = { repo: "acme/widgets", prompt: "fix the login bug" };
  const dispatched: { prompt: string; repo?: unknown }[] = [];
  const realDispatch = fakeDispatcher.dispatch;

  function turnCtx(userId: string, turnId: string): ToolContext {
    return { space: GUILD, isPrivate: false, turnId, owner: author(userId), store: {} as never, memory: {} as never, log: {} as never };
  }

  beforeEach(() => {
    config.ownerDiscordId = undefined;
    config.principals = { drk: { owner: true, identities: { discord: DRK } }, member: { identities: { discord: MEMBER } } };
    config.communities = { dc: { spaces: [{ surface: "discord", spaceId: GUILD.spaceId }], members: { member: { trusted: true } } } };
    dispatched.length = 0;
    fakeDispatcher.dispatch = async (input) => {
      dispatched.push(input as never);
      return realDispatch.call(fakeDispatcher, input);
    };
  });
  afterEach(() => {
    config.ownerDiscordId = prevOwner;
    config.principals = prevPrincipals;
    config.communities = prevCommunities;
    fakeDispatcher.dispatch = realDispatch;
    _resetParkedDispatches();
  });

  function tokenOf(content: string): string {
    const m = content.match(/confirm_token: ([0-9a-f]+)/);
    if (!m) throw new Error(`no token in: ${content}`);
    return m[1];
  }

  test("the owner dispatches immediately, no confirmation", async () => {
    const result = await dispatchToRunnerEntry.execute(args, turnCtx(DRK, "t1"));
    expect(result.content).toContain("Dispatched task task-1");
  });

  test("a member's first call parks the dispatch instead of running it", async () => {
    const result = await dispatchToRunnerEntry.execute(args, turnCtx(MEMBER, "t1"));
    expect(result.content).toContain("NOT dispatched yet");
    expect(result.content).toContain("acme/widgets");
    expect(dispatched).toHaveLength(0);
  });

  test("redeeming in the SAME turn is refused and does not burn the token", async () => {
    const token = tokenOf((await dispatchToRunnerEntry.execute(args, turnCtx(MEMBER, "t1"))).content);
    const same = await dispatchToRunnerEntry.execute({ confirm_token: token }, turnCtx(MEMBER, "t1"));
    expect(same.content).toContain("hasn't confirmed yet");
    expect(dispatched).toHaveLength(0);
    const later = await dispatchToRunnerEntry.execute({ confirm_token: token }, turnCtx(MEMBER, "t2"));
    expect(later.content).toContain("Dispatched task task-1");
  });

  test("a later-turn redeem dispatches exactly what was confirmed, once", async () => {
    const token = tokenOf((await dispatchToRunnerEntry.execute(args, turnCtx(MEMBER, "t1"))).content);
    await dispatchToRunnerEntry.execute({ confirm_token: token, prompt: "something else entirely" }, turnCtx(MEMBER, "t2"));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].prompt).toBe("fix the login bug");
    const again = await dispatchToRunnerEntry.execute({ confirm_token: token }, turnCtx(MEMBER, "t3"));
    expect(again.content).toContain("Unknown or expired");
    expect(dispatched).toHaveLength(1);
  });

  test("another principal can't redeem a member's token", async () => {
    const token = tokenOf((await dispatchToRunnerEntry.execute(args, turnCtx(MEMBER, "t1"))).content);
    const result = await dispatchToRunnerEntry.execute({ confirm_token: token }, turnCtx(DRK, "t2"));
    expect(result.content).toContain("Unknown or expired");
    expect(dispatched).toHaveLength(0);
  });

  test("a missing turnId never releases a parked dispatch (fail-closed)", async () => {
    const token = tokenOf((await dispatchToRunnerEntry.execute(args, turnCtx(MEMBER, "t1"))).content);
    const { turnId: _, ...noTurn } = turnCtx(MEMBER, "x");
    const result = await dispatchToRunnerEntry.execute({ confirm_token: token }, noTurn);
    expect(result.content).toContain("hasn't confirmed yet");
    expect(dispatched).toHaveLength(0);
  });
});
