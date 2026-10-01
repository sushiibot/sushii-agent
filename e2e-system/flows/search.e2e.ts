import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, test, type Page } from "../lib/harness.ts";

type Search = { query: string; hits: { source: string; id: string; role?: string; snippet: string; ranges: [number, number][] }[]; truncated: boolean; unavailable: string[] };

async function search(page: Page, q: string): Promise<{ status: number; body: Search }> {
  return page.evaluate(async (query) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    return { status: res.status, body: await res.json() };
  }, q);
}

test("search finds live and imported chat through the app API", async ({ page, watch }) => {
  await openChat(page);
  const tag = nonce();
  expect((await send(page, `E2E-ECHO searchable #${tag}`)).status).toBe(202);
  await expect(bubble(page, `re-${tag}`)).toContainText("Echo searchable.");

  await expect.poll(async () => (await search(page, tag)).body.hits.map((h) => `${h.source}:${h.role}`).sort(), { timeout: 15_000 }).toEqual(["chat:agent", "chat:user"]);
  const live = await search(page, tag);
  expect(live.status).toBe(200);
  // Notes come from the workspace, which may not answer history/search yet.
  expect(live.body.unavailable.filter((s) => s !== "notes")).toEqual([]);
  for (const h of live.body.hits) {
    const cps = [...h.snippet];
    expect(h.ranges.length).toBeGreaterThan(0);
    for (const [a, b] of h.ranges) expect(cps.slice(a, b).join("").toLowerCase()).toBe(tag);
  }

  const imported = await search(page, "E2E-PREWEB");
  expect(imported.body.hits.filter((h) => h.source === "chat" && Number(h.id) <= 0).length).toBe(2);

  const operators = await search(page, `${tag} OR zzzz`);
  expect(operators.status).toBe(200);
  expect(operators.body.hits.filter((h) => h.source === "chat")).toEqual([]);

  expect((await search(page, "x")).status).toBe(400);
  // Until the workspace answers runs/list the bot says so with 501, never a 5xx of its own.
  const runs = await page.evaluate(async () => (await fetch("/api/runs")).status);
  expect([200, 501]).toContain(runs);
  expect(await watch.violations()).toEqual([]);
});
