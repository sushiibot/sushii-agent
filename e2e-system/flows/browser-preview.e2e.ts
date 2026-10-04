import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("a real browser streams through the workspace and bot, hides without stopping, and closes after completion or cancellation", async ({ page }) => {
  test.skip(!process.env["E2E_BROWSER_EXECUTABLE_PATH"], "Set E2E_BROWSER_EXECUTABLE_PATH and install agent-browser for the real Chromium flow; CI also checks streaming in browser-smoke.");
  test.setTimeout(120_000);
  await openChat(page);
  const region = page.getByRole("region", { name: "Browser preview" });
  for (const cancel of [false, true]) {
    const tag = nonce();
    expect((await send(page, `E2E-BROWSER #${tag}`)).status).toBe(202);
    await expect(region.getByRole("img")).toBeVisible({ timeout: 30_000 });
    await expect(region).toContainText("Live");
    const endpoint = "/api/browser/status?conversation=main";
    const status = (await (await page.request.get(endpoint)).json()).status;
    expect(status.state).toBe("active");
    expect(status.url).toContain("/browser-preview");
    await region.getByRole("button", { name: "Hide browser preview" }).click();
    await expect(region.getByRole("img")).toBeHidden();
    expect((await (await page.request.get(endpoint)).json()).status.state).toBe("active");
    await region.getByRole("button", { name: "Show", exact: true }).click();
    await expect(region.getByRole("img")).toBeVisible();
    await region.getByRole("button", { name: "Expand browser preview" }).click();
    const viewer = page.getByRole("dialog");
    await expect(viewer.getByRole("img")).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(viewer).toContainText("Live");
    await page.goBack();
    await expect(viewer).toBeHidden();
    await expect(region).toContainText("Live");
    if (cancel) {
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await stack.releaseLlm(tag).catch(() => {});
    } else await stack.releaseLlm(tag);
    await expect.poll(async () => (await (await page.request.get(endpoint)).json()).status?.state).toBe("ended");
    await expect.poll(() => JSON.parse(readFileSync(join(process.env["E2E_WS_STATE"]!, "browser-sessions.json"), "utf8"))).toEqual([]);
  }
});
