// Chat screen helpers. When the app's routes change (e.g. Home at `/`), update openChat here and
// every flow follows.
import { expect, type Page } from "@playwright/test";

export const textbox = (page: Page) => page.getByRole("textbox", { name: "Message" });

/** Message bubbles containing `text`. */
export const bubble = (page: Page, text: string) => page.locator("[data-message-id]").filter({ hasText: text });

export async function openChat(page: Page) {
  const res = await page.goto("/chat");
  await expect(textbox(page)).toBeVisible();
  return res;
}

/** Types and sends a message; resolves with the POST /api/chat/messages response. */
export async function send(page: Page, text: string): Promise<{ status: number; body: string }> {
  const resP = page.waitForResponse((r) => r.url().endsWith("/api/chat/messages") && r.request().method() === "POST", { timeout: 15_000 });
  // Keep an early failure from surfacing as an unhandled rejection before we await it.
  resP.catch(() => {});
  await textbox(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  const res = await resP;
  return { status: res.status(), body: await res.text() };
}
