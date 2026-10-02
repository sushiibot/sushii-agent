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
  const qtag = nonce();
  const slow = `E2E-SLOW long reply E2E-HOLD #${tag}`;
  const queued = `E2E-ECHO queued while offline #${qtag}`;
  const slowReply = bubble(page, `re-${tag}`);
  const echoReply = bubble(page, `re-${qtag}`);

  expect((await send(page, slow)).status).toBe(202);
  await expect(slowReply).toContainText("slow3", { timeout: 20_000 });

  await context.setOffline(true);
  await textbox(page).fill(queued);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => outbox(page)).toContainEqual(queued);

  await stack.restartBot({ waitReady: true });
  // The held turn stays running across the restart while the outbox sends its queued message.
  const resent = page.waitForResponse((r) => r.url().endsWith("/api/chat/messages") && r.request().method() === "POST" && (r.request().postData() ?? "").includes(queued));
  await context.setOffline(false);
  expect((await resent).status()).toBe(202);
  await stack.releaseLlm(tag);

  await expect(slowReply).toContainText("slow29", { timeout: 30_000 });
  await expect(echoReply).toContainText("Echo queued.", { timeout: 30_000 });
  await expect.poll(() => outbox(page), { timeout: 30_000 }).toEqual([]);

  const counts = async () => ({
    slowUser: await bubble(page, slow).count(),
    slowReply: await slowReply.count(),
    queued: await bubble(page, queued).count(),
    echo: await echoReply.count(),
  });
  const once = { slowUser: 1, slowReply: 1, queued: 1, echo: 1 };
  const order = async () =>
    (await page.locator("[data-message-id]").allInnerTexts()).flatMap((t) =>
      t.includes(slow) ? ["slowUser"] : t.includes(`re-${tag}`) ? ["slowReply"] : t.includes(queued) ? ["queued"] : t.includes(`re-${qtag}`) ? ["echo"] : [],
    );
  const conversation = ["slowUser", "slowReply", "queued", "echo"];
  // Give any late duplicate (a replayed delivery or a second outbox send) time to show up.
  await page.waitForTimeout(3000);
  expect(await counts()).toEqual(once);
  expect(await order()).toEqual(conversation);

  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(slowReply).toContainText("slow29");
  await expect.poll(counts).toEqual(once);
  expect(await order()).toEqual(conversation);

  const dupes = await stack.query("select type, key, count(*) n from web_events where key is not null group by type, key having n > 1");
  expect(dupes).toEqual([]);
  expect((await stack.llmLog()).filter((l) => l.userText.includes(queued))).toHaveLength(1);
  expect(await watch.violations()).toEqual([]);
});
