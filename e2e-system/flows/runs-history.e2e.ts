// Runs and History reads over the real link: the bot asks, the workspace reads its seeded run index,
// transcripts and ~/history (stack/seed-runs.ts), and the bot process checks each result against the
// pinned contract. Called through the link directly until the bot has HTTP routes for them.
import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";
import { SEED } from "../stack/seed-runs.ts";

interface Run {
  runId: string;
  kind: string;
  status: string;
  jobName?: string;
  parentRunId?: string;
  turnId?: string;
  title: string;
}

async function ok<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const r = await stack.linkRequest<T>(method, params);
  expect(r.error).toBeUndefined();
  expect(r.schemaError).toBeNull();
  expect(r.bytes!).toBeLessThan(1_500_000);
  return r.result!;
}

test("runs/list and runs/get return the seeded job run, its child and its evidence", async () => {
  const list = await ok<{ runs: Run[]; truncated: boolean }>("runs/list", { limit: 50 });
  const job = list.runs.find((r) => r.runId === SEED.jobRunId);
  const child = list.runs.find((r) => r.runId === SEED.childRunId);
  expect(job).toMatchObject({ kind: "job", status: "done", jobName: SEED.jobName, title: "Run the nightly check" });
  expect(child).toMatchObject({ kind: "subagent", status: "failed", parentRunId: SEED.jobRunId });

  const failed = await ok<{ runs: Run[] }>("runs/list", { kinds: ["subagent", "agent"], statuses: ["failed", "timeout"] });
  expect(failed.runs.map((r) => r.runId)).toContain(SEED.childRunId);

  const detail = await ok<{
    found: boolean;
    session: string;
    steps: { type: string; name?: string; ok?: boolean | null; text?: string }[];
    children: Run[];
    evidence: { checks: { command: string; ok: boolean | null }[] };
    historyFile: string;
  }>("runs/get", { runId: SEED.jobRunId });
  expect(detail).toMatchObject({ found: true, session: "ok", historyFile: `2025-01/02-${SEED.jobRunId}.md` });
  expect(detail.steps.map((s) => s.type)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(detail.steps[2]).toMatchObject({ name: "bash", ok: true });
  expect(detail.evidence.checks).toEqual([expect.objectContaining({ command: "cd projects/app && bun test", ok: true })]);
  expect(detail.children.map((c) => c.runId)).toEqual([SEED.childRunId]);

  const childDetail = await ok<{ session: string; parent: Run }>("runs/get", { runId: SEED.childRunId });
  expect(childDetail).toMatchObject({ session: "missing", parent: { runId: SEED.jobRunId } });

  expect(await ok("runs/get", { runId: "01JGK3WEM0E2E000000000000Z" })).toEqual({ found: false });
});

test("history/days, history/day and history/search read ~/history and never follow a planted link", async () => {
  const days = await ok<{ days: { date: string; runs: number; sessions: number }[] }>("history/days", { limit: 60 });
  expect(days.days).toContainEqual({ date: SEED.date, runs: 1, sessions: 1 });
  const dates = days.days.map((d) => d.date);
  expect(dates).not.toContain("2025-01-03");
  expect(dates).not.toContain("2025-01-04");

  const day = await ok<{ found: boolean; sessions: { heading: string; markdown: string }[]; runs: Run[] }>("history/day", { date: SEED.date });
  expect(day.found).toBe(true);
  expect(day.sessions).toEqual([{ heading: "09:30 · rotate · nightly · `e2e.jsonl`", markdown: expect.stringContaining(SEED.needle) }]);
  expect(day.runs.map((r) => r.runId)).toEqual([SEED.jobRunId]);
  for (const date of ["2025-01-03", "2025-01-04"]) expect(await ok("history/day", { date })).toEqual({ found: false });

  const search = await ok<{ hits: { id: string; kind: string; date: string; runId?: string; snippet: string }[] }>("history/search", { query: SEED.needle });
  expect(search.hits.map((h) => [h.kind, h.date, h.runId ?? null])).toEqual([
    ["daily", SEED.date, null],
    ["run", SEED.date, SEED.jobRunId],
  ]);
  expect(JSON.stringify(search)).not.toContain(SEED.secret);
});

test("a chat run records the turn its reply belongs to", async ({ page }) => {
  await openChat(page);
  const tag = nonce();
  expect((await send(page, `E2E-ECHO turn #${tag}`)).status).toBe(202);
  await expect(bubble(page, `re-${tag}`)).toContainText("Echo turn.");
  const [reply] = await stack.query<{ turnId: string }>("select json_extract(data, '$.turnId') as turnId from web_events where type = 'reply' and data like ?", `%re-${tag}%`);
  expect(reply?.turnId).toBeTruthy();
  await expect
    .poll(async () => {
      const list = await ok<{ runs: Run[] }>("runs/list", { kinds: ["chat"], limit: 10 });
      return list.runs.find((r) => r.title.includes(`#${tag}`))?.turnId ?? null;
    })
    .toBe(reply!.turnId);
});
