import { bubble, openChat, send } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("a workspace restart recovers a queued steer without replaying the interrupted input", async ({ page, watch }) => {
  await openChat(page);
  const runningTag = nonce();
  const queuedTag = nonce();
  const running = `E2E-SLOW durable E2E-HOLD #${runningTag}`;
  const queued = `E2E-ECHO recovered #${queuedTag}`;
  try {
    expect((await send(page, running)).status).toBe(202);
    await expect(bubble(page, `re-${runningTag}`)).toContainText("slow3");
    expect((await send(page, queued)).status).toBe(202);
    // Pi has accepted the steer but cannot consume it while the current response is held.
    expect((await stack.llmLog()).filter((r) => r.userText.includes(queued))).toHaveLength(0);
    await stack.restartWorkspace();
    await expect(bubble(page, `re-${queuedTag}`)).toContainText("Echo recovered.");
    await expect(bubble(page, `re-${queuedTag}`)).toHaveCount(1);
    expect((await stack.llmLog()).filter((r) => r.userText.includes(running))).toHaveLength(1);
    expect((await stack.llmLog()).filter((r) => r.userText.includes(queued))).toHaveLength(1);
    await page.reload();
    await expect(bubble(page, `re-${queuedTag}`)).toHaveCount(1);
    expect(await watch.violations()).toEqual([]);
  } finally {
    await stack.releaseLlm(runningTag).catch(() => {});
  }
});
