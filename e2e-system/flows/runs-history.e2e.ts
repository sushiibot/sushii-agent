// Runs and History through the app: the bot's HTTP routes ask the workspace over the real link, the
// workspace reads its seeded run index, transcripts and ~/history (stack/seed-runs.ts), and the bot
// re-checks every answer against the pinned contract (502 when it doesn't parse). Then the same records
// on screen, in the real app.
import type { APIRequestContext } from "@playwright/test";
import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";
import { SEED } from "../stack/seed-runs.ts";

const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

interface Run {
  runId: string;
  kind: string;
  status: string;
  jobName?: string;
  parentRunId?: string;
  turnId?: string;
  title: string;
}

async function get<T>(request: APIRequestContext, path: string, status = 200): Promise<T> {
  const res = await request.get(path, { headers: SAME_ORIGIN });
  expect(res.status(), path).toBe(status);
  const body = await res.body();
  expect(body.length).toBeLessThan(1_500_000);
  return JSON.parse(body.toString("utf8")) as T;
}

test("GET /api/runs and /api/runs/:id return the seeded job run, its child and its evidence", async ({ request }) => {
  const list = await get<{ runs: Run[]; truncated: boolean }>(request, "/api/runs?limit=50");
  const job = list.runs.find((r) => r.runId === SEED.jobRunId);
  const child = list.runs.find((r) => r.runId === SEED.childRunId);
  expect(job).toMatchObject({ kind: "job", status: "done", jobName: SEED.jobName, title: "Run the nightly check" });
  expect(child).toMatchObject({ kind: "subagent", status: "failed", parentRunId: SEED.jobRunId });

  const failed = await get<{ runs: Run[] }>(request, "/api/runs?kind=subagent,agent&status=failed,timeout");
  expect(failed.runs.map((r) => r.runId)).toContain(SEED.childRunId);

  const detail = await get<{
    run: Run;
    session: string;
    steps: { type: string; name?: string; ok?: boolean | null; text?: string }[];
    children: Run[];
    evidence: { checks: { command: string; ok: boolean | null }[] };
    historyFile: string;
    approvals: unknown[];
    files: unknown[];
  }>(request, `/api/runs/${SEED.jobRunId}`);
  expect(detail).toMatchObject({ run: { runId: SEED.jobRunId }, session: "ok", historyFile: `2025-01/02-${SEED.jobRunId}.md`, approvals: [], files: [] });
  expect(detail.steps.map((s) => s.type)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(detail.steps[2]).toMatchObject({ name: "bash", ok: true });
  expect(detail.evidence.checks).toEqual([expect.objectContaining({ command: "cd projects/app && bun test", ok: true })]);
  expect(detail.children.map((c) => c.runId)).toEqual([SEED.childRunId]);

  const childDetail = await get<{ session: string; parent: Run }>(request, `/api/runs/${SEED.childRunId}`);
  expect(childDetail).toMatchObject({ session: "missing", parent: { runId: SEED.jobRunId } });

  await get(request, "/api/runs/01JGK3WEM0E2E000000000000Z", 404);
  await get(request, "/api/runs?before=not-a-run-id", 400);
});

test("GET /api/history and /api/search read ~/history and never follow a planted link", async ({ request }) => {
  const days = await get<{ days: { date: string; runs: number; sessions: number }[] }>(request, "/api/history/days?limit=60");
  expect(days.days).toContainEqual({ date: SEED.date, runs: 1, sessions: 1 });
  const dates = days.days.map((d) => d.date);
  expect(dates).not.toContain("2025-01-03");
  expect(dates).not.toContain("2025-01-04");

  const day = await get<{ found: boolean; sessions: { heading: string; markdown: string }[]; runs: Run[] }>(request, `/api/history/days/${SEED.date}`);
  expect(day.found).toBe(true);
  expect(day.sessions).toEqual([{ heading: "09:30 · rotate · nightly · `e2e.jsonl`", markdown: expect.stringContaining(SEED.needle) }]);
  expect(day.runs.map((r) => r.runId)).toEqual([SEED.jobRunId]);
  for (const date of ["2025-01-03", "2025-01-04"]) expect(await get(request, `/api/history/days/${date}`)).toEqual({ found: false });
  await get(request, "/api/history/days/2025-02-30", 404);

  const search = await get<{ hits: { source: string; kind?: string; date?: string; runId?: string; snippet: string }[]; unavailable: string[] }>(
    request,
    `/api/search?q=${SEED.needle}`,
  );
  expect(search.unavailable).toEqual([]);
  expect(search.hits.filter((h) => h.source === "notes").map((h) => [h.kind, h.date, h.runId ?? null])).toEqual([
    ["daily", SEED.date, null],
    ["run", SEED.date, SEED.jobRunId],
  ]);
  expect(JSON.stringify(search)).not.toContain(SEED.secret);
});

test("the inbox, a run, a History day and search open in the app on the workspace's records", async ({ page, watch }) => {
  // The inbox's server part answers from the bot and the workspace; the seeds are older than its 72 h window.
  const home = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/home");
  await page.goto("/inbox");
  expect((await home).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByText(/Couldn't load|Can't reach the agent|couldn't be read/)).toHaveCount(0);
  await page.getByRole("button", { name: /^Menu/ }).click();
  await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: /Runs/ }).click();
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Run the nightly check" }).first()).toBeVisible();

  await page.goto(`/runs/${SEED.jobRunId}`);
  await expect(page.getByText("Outcome, as the host recorded it")).toBeVisible();
  await expect(page.getByText("cd projects/app && bun test").first()).toBeVisible();
  await expect(page.getByText("E2E-RUNS nightly finished.")).toBeVisible();
  await page.getByRole("link", { name: /look around/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${SEED.childRunId}$`));
  await expect(page.getByText("it broke")).toBeVisible();

  await page.goto(`/history/${SEED.date}`);
  await expect(page.getByText(`recap mentions ${SEED.needle} in the daily notes`)).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: /Run the nightly check/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${SEED.jobRunId}$`));

  await page.goto(`/history/search?q=${SEED.needle}`);
  const hits = page.getByRole("main").getByRole("listitem");
  await expect(hits.filter({ hasText: "Day notes" })).toHaveCount(1);
  await expect(hits.filter({ hasText: "Run notes" })).toHaveCount(1);
  await expect(page.getByRole("main").locator("mark").first()).toHaveText(SEED.needle);
  await expect(page.getByText(SEED.secret)).toHaveCount(0);
  await hits.filter({ hasText: "Run notes" }).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/runs/${SEED.jobRunId}$`));
  expect(await watch.violations()).toEqual([]);
});

test("a chat run records the turn its reply belongs to", async ({ page, request }) => {
  await openChat(page);
  const tag = nonce();
  expect((await send(page, `E2E-ECHO turn #${tag}`)).status).toBe(202);
  await expect(bubble(page, `re-${tag}`)).toContainText("Echo turn.");
  const [reply] = await stack.query<{ turnId: string }>("select json_extract(data, '$.turnId') as turnId from web_events where type = 'reply' and data like ?", `%re-${tag}%`);
  expect(reply?.turnId).toBeTruthy();
  await expect
    .poll(async () => {
      const list = await get<{ runs: Run[] }>(request, "/api/runs?kind=chat&limit=10");
      return list.runs.find((r) => r.title.includes(`#${tag}`))?.turnId ?? null;
    })
    .toBe(reply!.turnId);
});
