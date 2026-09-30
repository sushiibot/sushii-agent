import type { Page } from "@playwright/test";
import { bubble, openChat, send, textbox } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

const outbox = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open("agent-chat");
        open.onsuccess = () => {
          const all = open.result.transaction("outbox").objectStore("outbox").getAll();
          all.onsuccess = () => resolve(all.result.map((x: { text: string }) => x.text));
        };
      }),
  );

test("a bot restart mid-turn leaves exactly one copy of each message", async ({ page, context, watch }) => {
  test.setTimeout(180_000);
  await openChat(page);
  const tag = nonce();
  const slow = `E2E-SLOW long reply ${tag}`;
  const queued = `E2E-ECHO ${tag} queued while offline`;

  expect((await send(page, slow)).status).toBe(202);
  await expect(page.getByText("slow3", { exact: false }).first()).toBeVisible({ timeout: 20_000 });

  await context.setOffline(true);
  await textbox(page).fill(queued);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => outbox(page)).toContainEqual(queued);

  await stack.restartBot({ waitReady: true });
  // Reconnect only after the slow turn is stored. Sent earlier, the queued message is steered into
  // the running turn, and whether it lands in that turn or a new one depends on timing.
  const slowReply = () => stack.query("select 1 from web_events where type = 'reply' and data like ?", "%slow29%");
  await expect.poll(slowReply, { timeout: 60_000 }).toHaveLength(1);
  await context.setOffline(false);

  await expect(page.getByText("slow29", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(bubble(page, `Echo ${tag}.`)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => outbox(page), { timeout: 30_000 }).toEqual([]);

  const counts = async () => ({
    slowUser: await bubble(page, slow).count(),
    slowReply: await bubble(page, "slow29").count(),
    queued: await bubble(page, queued).count(),
    echo: await bubble(page, `Echo ${tag}.`).count(),
  });
  const once = { slowUser: 1, slowReply: 1, queued: 1, echo: 1 };
  // Give any late duplicate (a replayed delivery or a second outbox send) time to show up.
  await page.waitForTimeout(3000);
  expect(await counts()).toEqual(once);

  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(page.getByText("slow29", { exact: false }).first()).toBeVisible();
  await expect.poll(counts).toEqual(once);

  const dupes = await stack.query("select type, key, count(*) n from web_events where key is not null group by type, key having n > 1");
  expect(dupes).toEqual([]);
  expect((await stack.llmLog()).filter((l) => l.userText.includes(queued))).toHaveLength(1);
  expect(await watch.violations()).toEqual([]);
});
