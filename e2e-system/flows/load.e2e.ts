import { openChat } from "../lib/chat.ts";
import { expect, test } from "../lib/harness.ts";

test("loads with Trusted Types enforced, no violations, and a registered service worker", async ({ page, watch }) => {
  const res = await openChat(page);
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toMatch(/trusted-types /);

  const sw = await page.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    return reg ? { scope: reg.scope, active: !!reg.active } : null;
  });
  expect(sw).toMatchObject({ active: true });

  expect(await watch.violations()).toEqual([]);
});
