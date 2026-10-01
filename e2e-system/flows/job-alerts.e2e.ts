import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { expect, nonce, stack, test, type CapturedPush } from "../lib/harness.ts";

const JOB = "e2e-alert";
const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

/** A disabled job runs only when requested, so nothing but this flow starts it. */
function schedule(prompt: string): void {
  writeFileSync(join(stack.wsHome, "schedule.md"), `# Schedule\n\n## ${JOB}\nwhen: every 60 minutes\nenabled: false\n\n${prompt}\n`);
}

function requestRun(): void {
  mkdirSync(join(stack.wsState, "requests"), { recursive: true });
  writeFileSync(join(stack.wsState, "requests", `${JOB}.request`), `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);
}

/** RFC 8291 aes128gcm, decrypted with the subscription's own keys. */
function decrypt(push: CapturedPush, ua: ReturnType<typeof createECDH>, auth: Buffer): unknown {
  const body = Buffer.from(push.body, "base64");
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const iv = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, iv);
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const padded = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  // The last record's padding delimiter is 0x02.
  expect(padded[end]).toBe(2);
  return JSON.parse(padded.subarray(0, end).toString("utf8"));
}

async function home(request: APIRequestContext) {
  const res = await request.get("/api/home", { headers: SAME_ORIGIN });
  expect(res.status()).toBe(200);
  return (await res.json()) as { failed: Array<{ id: string; kind: string; error?: string; runId?: string; seq: number }> };
}

test("a failing scheduled job shows on Home and pushes; its recovery clears it and quiets the notification", async ({ page, request, watch }) => {
  test.setTimeout(240_000);
  // No chat page is open, so no seen receipt can suppress the push.
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${nonce()}`;
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  const sub = await request.post("/api/push/subscribe", { headers: SAME_ORIGIN, data: { endpoint, keys } });
  expect(sub.status()).toBe(200);
  const ours = async () => (await stack.pushes()).filter((p) => p.endpoint === endpoint);

  try {
    schedule("E2E-JOBFAIL check something");
    requestRun();

    await expect.poll(async () => (await home(request)).failed.map((a) => a.id), { timeout: 90_000, intervals: [1000] }).toContain(`job:${JOB}`);
    const alert = (await home(request)).failed.find((a) => a.id === `job:${JOB}`)!;
    expect(alert).toMatchObject({ kind: "failed", error: expect.stringContaining("E2E-JOBFAIL") });
    expect(alert.runId).toMatch(RUN_ID_RE);
    const [event] = await stack.query<{ seq: number; data: string }>("select seq, data from web_events where type = 'alert' and json_extract(data, '$.alert.job') = ?", JOB);
    expect(event!.seq).toBe(alert.seq);
    expect(JSON.parse(event!.data)).toMatchObject({ alert: { source: "job", job: JOB, kind: "failed", trigger: "manual" }, text: expect.stringContaining(JOB) });

    await expect.poll(async () => (await ours()).length, { timeout: 20_000 }).toBe(1);
    const [push] = await ours();
    expect(decrypt(push!, ua, auth)).toMatchObject({
      title: "Scheduled job failed",
      tag: `job:${JOB}`,
      url: `/home?item=job:${JOB}`,
      body: expect.stringContaining(`${JOB}: `),
      renotify: true,
    });

    // The push's link, cold: the inbox loads, finds the job and opens it in its sheet.
    await page.goto("/inbox");
    const row = page.getByRole("button", { name: new RegExp(`${JOB} failed`) });
    await expect(row).toBeVisible();
    await page.goto(`/inbox?item=job:${JOB}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("E2E-JOBFAIL").first()).toBeVisible();
    await expect(page).toHaveURL(/\/inbox$/);

    schedule("E2E-NOREPLY check something");
    requestRun();
    await expect
      .poll(async () => stack.query("select data from web_events where type = 'alert_cleared' and json_extract(data, '$.id') = ?", `job:${JOB}`), { timeout: 90_000, intervals: [1000] })
      .toHaveLength(1);
    expect((await home(request)).failed.map((a) => a.id)).not.toContain(`job:${JOB}`);
    // The inbox was open the whole time: the cleared event takes the job off and its sheet says so.
    await expect(sheet.getByRole("heading", { name: "Already handled" })).toBeVisible();
    await expect(row).toBeHidden();
    const kinds = await stack.query<{ k: string }>("select json_extract(data, '$.alert.kind') k from web_events where type = 'alert' and json_extract(data, '$.alert.job') = ? order by seq", JOB);
    expect(kinds.map((r) => r.k)).toEqual(["failed", "recovered"]);
    const history = await request.get("/api/chat/history?limit=100", { headers: SAME_ORIGIN });
    const items = ((await history.json()) as { items: Array<{ type: string; alert?: { job: string } }> }).items;
    expect(items.filter((i) => i.type === "alert" && i.alert?.job === JOB)).toHaveLength(2);
    // The recovery replaces the failure notification without a sound.
    await expect.poll(async () => (await ours()).length, { timeout: 20_000 }).toBe(2);
    expect(decrypt((await ours())[1]!, ua, auth)).toMatchObject({ title: "Scheduled job working again", tag: `job:${JOB}`, silent: true });
    await new Promise((r) => setTimeout(r, 2000));
    expect(await ours()).toHaveLength(2);

    // Both alerts are in the chat once each, from history, as system lines.
    await page.goto("/chat");
    await expect(page.getByText(`Scheduled job ${JOB} failed`)).toHaveCount(1);
    await expect(page.getByText(`Scheduled job ${JOB} is working again`)).toHaveCount(1);
    // A link from before the inbox moved still lands on the item.
    await page.goto(`/home?item=job:${JOB}`);
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Already handled" })).toBeVisible();
    expect(await watch.violations()).toEqual([]);
  } finally {
    writeFileSync(join(stack.wsHome, "schedule.md"), "# Schedule\n");
    await request.delete("/api/push/subscribe", { headers: SAME_ORIGIN, data: { endpoint } });
  }
});
