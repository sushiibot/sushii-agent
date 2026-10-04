import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../../../db/index.ts";
import { startWebServer } from "../server.ts";
import { createVoiceRoutes } from "./routes.ts";

test("authenticated gateway upgrades and relays PCM through a real provider WebSocket", async () => {
  let receivedAudio = "";
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data));
        if (message.type === "session.update")
          socket.send(JSON.stringify({ type: "session.updated" }));
        if (message.type === "input_audio_buffer.append") {
          receivedAudio = message.audio;
          socket.send(
            JSON.stringify({
              type: "response.output_audio.delta",
              response_id: "r",
              delta: message.audio,
            }),
          );
        }
      },
    },
  });
  const voice = createVoiceRoutes(
    { OPENAI_REALTIME_API_KEY: "test" },
    async () => "done",
    () => new WebSocket(`ws://127.0.0.1:${provider.port}`),
  );
  const db = new Database(":memory:");
  applySchema(db);
  const gateway = await startWebServer(
    {
      port: 0,
      bindAddr: "127.0.0.1",
      ownerLogin: "owner@example.com",
      trustedPeers: ["127.0.0.1"],
      devLogin: undefined,
      push: undefined,
      distDir: "/tmp/unused-voice-test-dist",
    },
    db,
    { voice },
  );
  const url = `http://127.0.0.1:${gateway.port}`;
  let client: WebSocket | undefined;
  try {
    expect((await fetch(`${url}/api/voice/models`)).status).toBe(403);
    const models = await fetch(`${url}/api/voice/models`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    expect(models.status).toBe(200);
    expect(JSON.stringify(await models.json())).not.toContain('"key"');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("voice relay timed out")),
        3000,
      );
      client = new (
        WebSocket as unknown as new (
          url: string,
          options: Bun.WebSocketOptions,
        ) => WebSocket
      )(`${url.replace("http:", "ws:")}/api/voice/connect?provider=openai`, {
        headers: { Origin: url, "Tailscale-User-Login": "owner@example.com" },
      });
      client.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("voice handshake failed"));
      };
      client.onmessage = ({ data }) => {
        const event = JSON.parse(String(data));
        if (event.type === "ready")
          client!.send(JSON.stringify({ type: "audio", audio: "AAA=" }));
        if (event.type === "audio") {
          expect(event.audio).toBe("AAA=");
          clearTimeout(timeout);
          resolve();
        }
      };
    });
    expect(receivedAudio).toBe("AAA=");
  } finally {
    client?.close();
    voice.close();
    await gateway.stop(true);
    await provider.stop(true);
    db.close();
  }
});
