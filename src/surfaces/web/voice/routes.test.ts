import { expect, test } from "bun:test";
import { createVoiceRoutes } from "./routes.ts";
import { mintWebActor } from "../actor.ts";
const actor = mintWebActor("owner@example.com");
const request = (origin?: string, provider = "openai") =>
  new Request(`https://agent.test/api/voice/connect?provider=${provider}`, {
    headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) },
  });
test("voice requires an exact browser origin and configured credentials before upgrading", async () => {
  const routes = createVoiceRoutes(
    { OPENAI_REALTIME_API_KEY: "secret" },
    async () => "done",
  );
  expect(
    (await routes.handle(request(), "/api/voice/connect", actor))?.status,
  ).toBe(403);
  expect(
    (
      await routes.handle(
        request("https://attacker.test"),
        "/api/voice/connect",
        actor,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await routes.handle(
        request("https://agent.test", "qwen"),
        "/api/voice/connect",
        actor,
      )
    )?.status,
  ).toBe(503);
  let upgrades = 0;
  const server = {
    timeout() {},
    upgrade() {
      upgrades++;
      return true;
    },
  };
  expect(
    (
      await routes.handle(
        request("https://agent.test"),
        "/api/voice/connect",
        actor,
        server,
      )
    )?.status,
  ).toBe(204);
  expect(
    (
      await routes.handle(
        request("https://agent.test"),
        "/api/voice/connect",
        actor,
        server,
      )
    )?.status,
  ).toBe(409);
  expect(upgrades).toBe(1);
  routes.close();
  expect(
    (
      await routes.handle(
        request("https://agent.test"),
        "/api/voice/connect",
        actor,
        server,
      )
    )?.status,
  ).toBe(204);
  routes.close();
});
