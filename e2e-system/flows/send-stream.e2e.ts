import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("a sent message reaches the workspace and the streamed reply renders as markdown", async ({ page, watch }) => {
  await openChat(page);
  const tag = nonce();
  const text = `Hello markdown #${tag}`;

  const r = await send(page, text);
  expect(r.status).toBe(202);

  // The fake model streams four pieces 400ms apart; the first must show before the last arrives.
  const reply = bubble(page, `re-${tag}`);
  await expect(reply).toContainText("Bold reply");
  await expect(reply).not.toContainText("Done.");
  await expect(reply).toContainText("Done.");

  const seen = await stack.waitForLlm((l) => l.userText.includes(text));
  expect(seen.userText).toContain(text);

  const md = await reply.evaluate((el) => ({
    strong: !!el.querySelector("strong"),
    li: el.querySelectorAll("li").length,
    code: el.querySelector("pre code")?.textContent ?? "",
    raw: /\*\*|```/.test(el.textContent ?? ""),
  }));
  expect(md).toEqual({ strong: true, li: 2, code: expect.stringContaining("const answer = 42;"), raw: false });

  await expect(bubble(page, text)).toHaveCount(1);
  await expect(reply).toHaveCount(1);
  expect(await watch.violations()).toEqual([]);
});

 test("typing follows reasoning events while a model without reasoning stays waiting", async ({ page, watch }) => {
  await openChat(page);
  const typing = page.locator("[data-typing]");
  const visible = typing.locator("[aria-hidden=true]");
  const tag = nonce();
  await send(page, `E2E-THINK #${tag}`);
  await expect(visible).toHaveText("Waiting for the model…");
  await expect(visible.locator("[data-thinking-emoji]")).toBeVisible();
  await expect(visible.locator(".typing-status")).not.toHaveText("Thinking…");
  await expect(typing.locator(".sr-only")).toHaveText("Thinking…");
  await expect(page.getByText("Private reasoning must never appear in chat.", { exact: true })).toHaveCount(0);
  await expect(bubble(page, `re-${tag}`)).toContainText("Thoughtful reply.");
  await expect(typing).toBeHidden();
  const waitTag = nonce();
  await send(page, `E2E-WAIT #${waitTag}`);
  await expect(visible).toHaveText("Waiting for the model…");
  await page.waitForTimeout(2200);
  await expect(visible).toHaveText("Waiting for the model…");
  await expect(bubble(page, `re-${waitTag}`)).toContainText("Reply without reasoning.");
  await expect(typing).toBeHidden();
  expect(await watch.violations()).toEqual([]);
 });
