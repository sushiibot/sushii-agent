import http from "node:http";
import { expect, stack, test } from "../lib/harness.ts";

const { addrs, ports, ownerLogin } = stack.config;

/** A raw request straight to the bot, bypassing the proxy, from a chosen loopback address. */
function direct(localAddress: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: addrs.bot, port: ports.web, localAddress, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

const owner = { "Tailscale-User-Login": ownerLogin, "Sec-Fetch-Site": "same-origin" };

test("an untrusted peer gets 403 even with the owner login header", async () => {
  expect((await direct(addrs.untrusted, "/api/me", owner)).status).toBe(403);
  expect((await direct(addrs.untrusted, "/", owner)).status).toBe(403);
});

test("the trusted peer is accepted only with the owner login", async () => {
  expect((await direct(addrs.trustedPeer, "/api/me", owner)).status).toBe(200);
  expect((await direct(addrs.trustedPeer, "/api/me", { ...owner, "Tailscale-User-Login": "mallory@e2e" })).status).toBe(403);
  expect((await direct(addrs.trustedPeer, "/api/me", { "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
});

test("a forged login header through the proxy is overwritten", async ({ request }) => {
  const res = await request.get("/api/me", { headers: { "Tailscale-User-Login": "attacker@e2e", "Sec-Fetch-Site": "same-origin" } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ login: ownerLogin });
});
