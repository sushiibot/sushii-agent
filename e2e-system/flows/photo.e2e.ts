import { readdirSync } from "node:fs";
import { join } from "node:path";
import { bubble, openChat, send, textbox } from "../lib/chat.ts";
import { expect, nonce, stack, test } from "../lib/harness.ts";

test("an uploaded photo reaches the workspace and the model", async ({ page }) => {
  await openChat(page);
  const jpeg = await page.evaluate(async () => {
    const c = new OffscreenCanvas(640, 480);
    const g = c.getContext("2d")!;
    g.fillStyle = "#c33";
    g.fillRect(0, 0, 640, 480);
    const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });

  const upP = page.waitForResponse((r) => r.url().endsWith("/api/uploads"));
  await page.locator("input[type=file]").setInputFiles({ name: "e2e-photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg) });
  const up = await upP;
  expect(up.status()).toBe(200);
  const { id } = (await up.json()) as { id: string };
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);

  const tag = nonce();
  const text = `E2E-PHOTO what is this #${tag}`;
  expect((await send(page, text)).status).toBe(202);
  await expect(bubble(page, `re-${tag}`)).toContainText("I received 1 image part(s)", { timeout: 30_000 });

  const seen = await stack.waitForLlm((l) => l.userText.includes(text));
  expect(seen.lastImages).toBe(1);
  expect(readdirSync(join(stack.wsHome, "uploads")).some((f) => f.startsWith(id))).toBe(true);

  const f = await page.request.get(`/f/${id}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
  expect(f.status()).toBe(200);
  expect(f.headers()).toMatchObject({ "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
  expect(f.headers()["content-security-policy"]).toContain("sandbox");

  await page.reload();
  await expect(textbox(page)).toBeVisible();
  await expect(bubble(page, text).locator(`img[src="/f/${id}"]`)).toBeVisible();
});
