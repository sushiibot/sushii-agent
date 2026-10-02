import { bubble, openChat, send, textbox } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("topic conversations stream independently, survive restart and report back to Main", async ({
  page,
  context,
  watch,
}) => {
  await openChat(page);
  const tag = nonce();
  await send(page, `Main question #${tag}`);
  await expect(bubble(page, `re-${tag}`)).toContainText("Done.");
  await page
    .getByRole("button", { name: "Start a thread from here" })
    .last()
    .click();
  const branch = page.getByRole("dialog", { name: "Start a thread" });
  await branch
    .getByRole("textbox", { name: "Thread name" })
    .fill(`Trip ${tag}`);
  await branch
    .getByRole("button", { name: "Start thread", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const topicUrl = page.url();
  const topicTag = nonce();
  await textbox(page).fill(`Topic question #${topicTag}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(bubble(page, `re-${topicTag}`)).toContainText("Done.");
  // The brief intentionally quotes Main; the topic transcript itself contains only its own replies.
  const topicHistory = await page.evaluate(async () =>
    (
      await fetch(
        `/api/threads/${location.pathname.split("/").at(-1)}/chat/history`,
      )
    ).json(),
  );
  expect(
    topicHistory.items.filter(
      (i: { type: string; text?: string }) =>
        i.type === "assistant" && i.text?.includes(`re-${tag}`),
    ),
  ).toHaveLength(0);
  const main = await context.newPage();
  await openChat(main);
  await expect(bubble(main, `re-${topicTag}`)).toHaveCount(0);
  await stack.restartWorkspace();
  await page.reload();
  await expect(bubble(page, `re-${topicTag}`)).toContainText("Done.");
  const resumed = nonce();
  await textbox(page).fill(`Resumed topic #${resumed}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(bubble(page, `re-${resumed}`)).toContainText("Done.");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const close = page.getByRole("dialog", { name: "Close thread" });
  await close
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(
    page.getByText(`Thread closed · Trip ${tag}`, { exact: false }).first(),
  ).toBeVisible();
  await page.goto(topicUrl);
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  await expect(textbox(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(textbox(page)).toBeVisible();
  expect(await watch.violations()).toEqual([]);
});

test("Main keeps streaming when a simultaneous topic is stopped", async ({
  page,
  context,
  watch,
}) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: "New thread" }).click();
  const branch = page.getByRole("dialog", { name: "Start a thread" });
  await branch
    .getByRole("textbox", { name: "Thread name" })
    .fill(`Independent ${nonce()}`);
  await branch
    .getByRole("button", { name: "Start thread", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const topicTag = nonce();
  await textbox(page).fill(`E2E-SLOW topic #${topicTag}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(bubble(page, `re-${topicTag}`)).toContainText("slow3");
  const main = await context.newPage();
  await openChat(main);
  const mainTag = nonce();
  await send(main, `E2E-SLOW Main #${mainTag}`);
  await expect(bubble(main, `re-${mainTag}`)).toContainText("slow3");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await expect(bubble(main, `re-${mainTag}`)).toContainText("slow29", {
    timeout: 30000,
  });
  await expect(bubble(page, `re-${mainTag}`)).toHaveCount(0);
  expect(await watch.violations()).toEqual([]);
});

test("a topic approval stays in its conversation after reload and Deny reaches that session", async ({
  page,
  context,
  watch,
}) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: "New thread" }).click();
  const branch = page.getByRole("dialog", { name: "Start a thread" });
  await branch
    .getByRole("textbox", { name: "Thread name" })
    .fill(`Approval ${nonce()}`);
  await branch
    .getByRole("button", { name: "Start thread", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const tag = nonce();
  await textbox(page).fill(`E2E-APPROVE file an issue #${tag}`);
  await page.getByRole("button", { name: "Send message" }).click();
  const approve = page.getByRole("button", {
    name: "Approve file_linear_issue",
  });
  await expect(approve).toBeVisible();
  const main = await context.newPage();
  await openChat(main);
  await expect(
    main.getByRole("button", { name: "Approve file_linear_issue" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(approve).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Deny file_linear_issue" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Deny file_linear_issue" }).click();
  await expect(approve).toHaveCount(0);
  await expect(bubble(page, `re-${tag}`)).toContainText(
    /Tool finished\. Result: .*denied/i,
  );
  await expect(bubble(main, `re-${tag}`)).toHaveCount(0);
  expect(await watch.violations()).toEqual([]);
});
