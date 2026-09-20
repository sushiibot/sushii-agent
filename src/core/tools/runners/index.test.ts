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

const { dispatchToRunnerEntry, listRunningSessionsEntry, readSessionEntry, resumeSessionEntry, RUNNER_TOOL_ENTRIES } = await import("./index.ts");
const { config } = await import("../../../config.ts");
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

  beforeEach(() => {
    config.ownerDiscordId = OWNER;
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
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

describe("runner tools: dispatcher unavailable (getDispatcher listen failure)", () => {
  const prevOwner = config.ownerDiscordId;

  beforeEach(() => {
    config.ownerDiscordId = OWNER;
    dispatcherUnavailable = true;
  });

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
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

  afterEach(() => {
    config.ownerDiscordId = prevOwner;
  });

  function names(owner: boolean, spaceId: string): string[] {
    const registry = createToolRegistry(RUNNER_TOOL_ENTRIES, () => ({ exa: true, owner, grafanaBaseUrl: true, linear: true }));
    return registry.resolve(fakeSession(), { surface: "discord", spaceId }).map((e) => e.name);
  }

  test("hidden in a guild space even with an owner configured", () => {
    expect(names(true, "guild-1")).toEqual([]);
  });

  test("offered in a personal/DM space with an owner configured", () => {
    expect(names(true, "dm")).toEqual(["dispatch_to_runner", "list_runners", "list_running_sessions", "read_session", "resume_session"]);
  });

  test("hidden in a personal/DM space when no owner is configured", () => {
    expect(names(false, "dm")).toEqual([]);
  });
});
