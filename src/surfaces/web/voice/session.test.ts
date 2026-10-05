import { expect, test } from "bun:test";
import { VoiceSession, type VoiceSocketData } from "./session.ts";
import { voiceConfigs } from "./providers.ts";
import { mintWebActor } from "../actor.ts";
import type { ServerWebSocket } from "bun";
function harness() {
  const upstream: any = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    sent: [] as any[],
    send(text: string) {
      this.sent.push(JSON.parse(text));
    },
    close() {},
  };
  const client: any = {
    sent: [] as any[],
    send(text: string) {
      this.sent.push(JSON.parse(text));
    },
    getBufferedAmount: () => 0,
    close() {},
  };
  let finish!: (text: string) => void;
  let calls = 0;
  let ended = false;
  const session = new VoiceSession(
    voiceConfigs({ OPENAI_REALTIME_API_KEY: "test" }).find(
      (c) => c.id === "openai",
    )!,
    mintWebActor("owner@example.com"),
    "main",
    async () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => {
      ended = true;
    },
    () => upstream as WebSocket,
  );
  session.open(client as ServerWebSocket<VoiceSocketData>);
  upstream.onopen();
  const event = (data: unknown) =>
    upstream.onmessage({ data: JSON.stringify(data) });
  event({ type: "session.updated" });
  return {
    session,
    client,
    upstream,
    event,
    finish: (text: string) => finish(text),
    calls: () => calls,
    ended: () => ended,
  };
}
test("backend work is acknowledged immediately, duplicate calls don't run twice, and results wait for playback", async () => {
  const h = harness();
  try {
    h.event({ type: "response.created", response: { id: "r" } });
    const call = {
      type: "response.function_call_arguments.done",
      call_id: "call",
      name: "ask_sushii",
      arguments: '{"request":"do work"}',
    };
    h.event(call);
    h.event(call);
    expect(h.calls()).toBe(1);
    expect(
      h.upstream.sent.some((m: any) => m.item?.type === "function_call_output"),
    ).toBe(true);
    expect(
      h.upstream.sent.filter((m: any) => m.type === "response.create"),
    ).toHaveLength(0);
    h.event({ type: "response.done" });
    expect(
      h.upstream.sent.filter((m: any) => m.type === "response.create"),
    ).toHaveLength(1);
    h.event({ type: "response.audio.delta", delta: "AAA=" });
    h.finish("Work completed");
    await new Promise((resolve) => setImmediate(resolve));
    h.event({ type: "response.done" });
    expect(
      h.upstream.sent.filter((m: any) => m.type === "response.create"),
    ).toHaveLength(1);
    h.session.message(JSON.stringify({ type: "playback_idle" }));
    expect(
      h.upstream.sent.filter((m: any) => m.type === "response.create"),
    ).toHaveLength(2);
    expect(JSON.stringify(h.upstream.sent)).toContain("Work completed");
  } finally {
    h.session.close();
  }
});
test("client cannot send provider commands or arbitrary tool calls", () => {
  const h = harness();
  h.session.message(
    JSON.stringify({
      type: "session.update",
      session: { instructions: "changed" },
    }),
  );
  expect(h.ended()).toBe(true);
  expect(h.client.sent.at(-1).type).toBe("error");
  expect(JSON.stringify(h.upstream.sent)).not.toContain("changed");
});
test("closing a call releases the upstream and ignores late backend results", async () => {
  const h = harness();
  h.event({
    type: "response.function_call_arguments.done",
    call_id: "call",
    name: "ask_sushii",
    arguments: '{"request":"work"}',
  });
  h.session.close();
  const count = h.upstream.sent.length;
  h.finish("late result");
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.upstream.sent).toHaveLength(count);
  expect(h.ended()).toBe(true);
});
test("interruption discards late audio from the interrupted response", () => {
  const h = harness();
  try {
    h.event({ type: "response.created", response: { id: "old" } });
    h.event({ type: "input_audio_buffer.speech_started" });
    h.event({
      type: "response.output_audio.delta",
      response_id: "old",
      delta: "AAA=",
    });
    expect(h.client.sent.filter((m: any) => m.type === "audio")).toHaveLength(
      0,
    );
    h.event({ type: "response.created", response: { id: "new" } });
    h.event({
      type: "response.output_audio.delta",
      response_id: "new",
      delta: "AAA=",
    });
    expect(h.client.sent.filter((m: any) => m.type === "audio")).toHaveLength(
      1,
    );
  } finally {
    h.session.close();
  }
});
test("background announcements wait for a quiet input window even without provider VAD events", async () => {
  const h = harness();
  try {
    h.event({
      type: "response.function_call_arguments.done",
      call_id: "call",
      name: "ask_sushii",
      arguments: '{"request":"work"}',
    });
    const pcm = Buffer.alloc(640);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(10000, i);
    h.session.message(
      JSON.stringify({ type: "audio", audio: pcm.toString("base64") }),
    );
    h.finish("Background result");
    await new Promise((resolve) => setImmediate(resolve));
    h.event({ type: "response.done" });
    expect(JSON.stringify(h.upstream.sent)).not.toContain("Background result");
    await Bun.sleep(750);
    expect(JSON.stringify(h.upstream.sent)).toContain("Background result");
  } finally {
    h.session.close();
  }
});
