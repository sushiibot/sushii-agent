import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("a sent message reaches the workspace and the streamed reply renders as markdown", async ({ page, watch }) => {
  await openChat(page);
  const text = `Hello markdown ${nonce()}`;

  const r = await send(page, text);
  expect(r.status).toBe(202);

  // The fake model streams four pieces 400ms apart; the first must show before the last arrives.
  const reply = bubble(page, "Bold reply").last();
  await expect(reply).toBeVisible();
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
  expect(await watch.violations()).toEqual([]);
});
