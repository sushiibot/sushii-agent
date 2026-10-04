import { expect, test } from "bun:test";
import { adapterFor, publicModels, voiceConfigs } from "./providers.ts";
const configs = voiceConfigs({
  DASHSCOPE_API_KEY: "q-secret",
  DASHSCOPE_WORKSPACE_ID: "workspace",
  GEMINI_API_KEY: "g-secret",
  OPENAI_REALTIME_API_KEY: "o-secret",
});
test("catalog defaults to cheapest configured model and never exposes credentials", () => {
  const models = publicModels(configs);
  expect(models.map((m) => m.id)).toEqual(["qwen", "gemini", "openai"]);
  expect(models.every((m) => m.configured)).toBe(true);
  expect(JSON.stringify(models)).not.toContain("secret");
  expect(voiceConfigs({})[0]!.configured).toBe(false);
  expect(voiceConfigs({ DASHSCOPE_API_KEY: "x" })[0]!.configured).toBe(false);
  expect(() => voiceConfigs({ DASHSCOPE_WORKSPACE_ID: "evil/host" })).toThrow();
});
test("Qwen 3.8 uses its workspace endpoint, nested PCM format and function calls", () => {
  const a = adapterFor(configs[0]!);
  expect(a.url).toBe(
    "wss://workspace.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime",
  );
  const setup = a.setup() as any;
  expect(setup.session.audio.input.format.sample_rate).toBe(16000);
  expect(setup.session.audio.output.format.sample_rate).toBe(24000);
  expect(setup.session.tools[0].name).toBe("ask_sushii");
  expect(
    a.events({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "ask_sushii",
      arguments: '{"request":"check my calendar"}',
    }),
  ).toEqual([
    {
      type: "tool",
      id: "call-1",
      name: "ask_sushii",
      args: { request: "check my calendar" },
    },
  ]);
  expect(a.events({ type: "input_audio_buffer.speech_started" })).toEqual([
    { type: "interrupted" },
  ]);
});
test("OpenAI uses the GA protocol and normalizes audio, transcripts and tools", () => {
  const a = adapterFor(configs[2]!);
  const setup = a.setup() as any;
  expect(setup.session.type).toBe("realtime");
  expect(setup.session.output_modalities).toEqual(["audio"]);
  expect(setup.session.audio.input.format.rate).toBe(24000);
  expect(
    a.events({ type: "response.output_audio.delta", delta: "AAA=" }),
  ).toEqual([
    { type: "audio", audio: "AAA=", sampleRate: 24000, responseId: undefined },
  ]);
  expect(
    a.events({
      type: "response.output_audio_transcript.delta",
      delta: "hello",
    }),
  ).toEqual([
    { type: "transcript", role: "assistant", text: "hello", final: false },
  ]);
  expect(a.toolResult("call", "done")).toEqual([
    {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call", output: "done" },
    },
    { type: "response.create" },
  ]);
});
test("Gemini Live maps setup, PCM, transcription, interruptions and automatic tool continuation", () => {
  const a = adapterFor(configs[1]!);
  const setup = a.setup() as any;
  expect(setup.setup.model).toBe("models/gemini-3.8-live");
  expect(setup.setup.tools[0].functionDeclarations[0].parameters.type).toBe(
    "OBJECT",
  );
  expect(setup.setup.contextWindowCompression.slidingWindow.targetTokens).toBe(
    6000,
  );
  expect(a.audio("AAA=")).toEqual({
    realtimeInput: {
      audio: { data: "AAA=", mimeType: "audio/pcm;rate=16000" },
    },
  });
  expect(a.events({ setupComplete: {} })).toEqual([
    { type: "ready", inputRate: 16000 },
  ]);
  expect(
    a.events({
      toolCall: {
        functionCalls: [
          { id: "c", name: "ask_sushii", args: { request: "help" } },
        ],
      },
    }),
  ).toEqual([
    { type: "tool", id: "c", name: "ask_sushii", args: { request: "help" } },
  ]);
  expect(a.toolResult("c", "done")).toHaveLength(1);
  expect(
    a.events({
      serverContent: {
        interrupted: true,
        modelTurn: {
          parts: [
            { inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } },
          ],
        },
      },
    }),
  ).toEqual([{ type: "interrupted" }]);
});
