import { bubble, openChat, send, textbox } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("a pending approval survives a reload and Deny reaches the workspace", async ({ page, watch }) => {
  await openChat(page);
  const tag = nonce();
  const text = `E2E-APPROVE file an issue #${tag}`;
  expect((await send(page, text)).status).toBe(202);

  const approve = page.getByRole("button", { name: "Approve file_linear_issue" });
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(approve).toBeVisible();

  // The tray ignores taps for a moment after it appears, so a stray tap can't decide.
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "Deny file_linear_issue" }).click();
  await expect(approve).toHaveCount(0);
  await expect(bubble(page, `re-${tag}`)).toContainText(/Tool finished\. Result: .*denied/i);

  const toolTurn = await stack.waitForLlm((l) => l.userText.includes(text) && l.lastRole === "tool");
  expect(toolTurn.lastTool).toMatch(/denied/i);
  // The fake model puts the tag in the tool call's title, so this finds this flow's approval.
  const [asked] = await stack.query<{ key: string }>("select key from web_events where type = 'approval' and data like ?", `%${tag}%`);
  expect(asked).toBeDefined();
  const resolved = await stack.query<{ data: string }>("select data from web_events where type = 'approval_resolved' and key = ?", asked!.key);
  expect(resolved).toHaveLength(1);
  expect(JSON.parse(resolved[0]!.data)).toMatchObject({ decision: "deny" });
  expect(await watch.violations()).toEqual([]);
});
