import { openChat, send, textbox } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("a pending approval survives a reload and Deny reaches the workspace", async ({ page, watch }) => {
  await openChat(page);
  const text = `E2E-APPROVE file an issue ${nonce()}`;
  expect((await send(page, text)).status).toBe(202);

  const approve = page.getByRole("button", { name: "Approve file_linear_issue" });
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(approve).toBeVisible();

  const before = (await stack.llmLog()).length;
  // The tray ignores taps for a moment after it appears, so a stray tap can't decide.
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "Deny file_linear_issue" }).click();
  await expect(page.getByText("Denied").first()).toBeVisible();

  const toolTurn = await stack.waitForLlm((l) => l.n > before && l.lastRole === "tool");
  expect(toolTurn.lastTool).toMatch(/denied/i);
  const resolved = await stack.query<{ data: string }>("select data from web_events where type = 'approval_resolved' order by seq desc limit 1");
  expect(resolved[0]?.data).toMatch(/deny/);
  expect(await watch.violations()).toEqual([]);
});
