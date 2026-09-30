import type { Page } from "@playwright/test";
import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

const texts = (page: Page) => page.locator("[data-message-id]").allInnerTexts();

/** This flow's bubbles in page order, each named by the first marker it contains. */
async function order(page: Page, markers: Record<string, string>): Promise<string[]> {
  return (await texts(page)).flatMap((t) => Object.entries(markers).filter(([, m]) => t.includes(m)).slice(0, 1).map(([name]) => name));
}

test("a message sent while a reply streams keeps the streamed text, live and after a reload", async ({ page, watch }) => {
  test.setTimeout(120_000);
  await openChat(page);
  const tag = nonce();
  const qtag = nonce();
  const slow = `E2E-SLOW steered reply #${tag}`;
  const steer = `E2E-ECHO steered #${qtag}`;
  const slowReply = bubble(page, `re-${tag}`);

  expect((await send(page, slow)).status).toBe(202);
  await expect(slowReply).toContainText("slow3", { timeout: 20_000 });
  expect((await send(page, steer)).status).toBe(202);

  const echoReply = bubble(page, `re-${qtag}`);
  await expect(echoReply).toContainText("Echo steered.", { timeout: 40_000 });
  const stored = await stack.query("select 1 from web_events where type = 'reply' and data like ?", `%re-${qtag}%`);
  expect(stored).toHaveLength(1);

  const live = await texts(page);
  await expect(slowReply).toContainText("slow29");
  await expect(slowReply).toHaveCount(1);
  await expect(echoReply).toHaveCount(1);
  const markers = { slowUser: "E2E-SLOW steered", slowReply: `re-${tag}`, steerUser: "E2E-ECHO steered", echoReply: `re-${qtag}` };
  const expected = ["slowUser", "slowReply", "steerUser", "echoReply"];
  expect(await order(page, markers)).toEqual(expected);

  await page.reload();
  await expect(echoReply).toContainText("Echo steered.");
  await expect(slowReply).toContainText("slow29");
  await expect(slowReply).toHaveCount(1);
  await expect(echoReply).toHaveCount(1);
  const own = (all: string[]) => all.filter((t) => t.includes(tag) || t.includes(qtag));
  expect(own(await texts(page)).length).toBe(own(live).length);
  expect(await order(page, markers)).toEqual(expected);

  expect((await stack.llmLog()).filter((l) => l.userText.includes(steer))).toHaveLength(1);
  expect(await watch.violations()).toEqual([]);
});
