import { describe, expect, test } from "bun:test";
import { BuzzSurfaceSession } from "./session.ts";
import type { BuzzClient } from "./buzzClient.ts";
import type { FsHost } from "../../core/contracts.ts";

const client = {} as BuzzClient;
const base = { client, ownPubkey: "pk", channelId: "c1", replyToId: "e1" };

describe("BuzzSurfaceSession wiki host gating", () => {
  test("no fs host → no wiki tools (hosts is empty)", () => {
    const session = new BuzzSurfaceSession(base);
    expect(session.hosts.fs).toBeUndefined();
  });

  test("fs host provided → exposed as hosts.fs so the community can search its wiki", () => {
    const fsHost = { label: "wiki" } as FsHost;
    const session = new BuzzSurfaceSession({ ...base, fsHost });
    expect(session.hosts.fs).toBe(fsHost);
  });
});
