import { bubble, openChat, textbox } from "../lib/chat.ts";
import { expect, stack, test } from "../lib/harness.ts";

const imported = () => stack.query<{ type: string; key: string; seq: number }>("select type, key, seq from web_events where key like 'pi:%' order by seq");

test("the pre-web Main conversation is imported once and shows like live chat", async ({ page, watch }) => {
  test.setTimeout(120_000);
  await expect.poll(imported, { timeout: 30_000 }).toHaveLength(2);
  const rows = await imported();
  expect(rows.map((r) => r.type)).toEqual(["user", "reply"]);
  expect(rows.every((r) => r.seq <= 0)).toBe(true);
  expect(await stack.query("select 1 from kv where key = 'web_events:pi_import_done'")).toHaveLength(1);

  await openChat(page);
  const question = bubble(page, "E2E-PREWEB question from Discord");
  const answer = bubble(page, "E2E-PREWEB answer from before the app");
  await expect(question).toHaveCount(1);
  await expect(answer).toHaveCount(1);
  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(question).toHaveCount(1);
  await expect(answer).toHaveCount(1);

  // A second workspace connect finds the import done and adds nothing.
  await stack.restartBot({ waitReady: true });
  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(answer).toHaveCount(1);
  await expect(question).toHaveCount(1);
  expect(await imported()).toEqual(rows);
  expect(await watch.violations()).toEqual([]);
});
