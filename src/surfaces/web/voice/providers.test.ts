import { expect, test } from "bun:test";
import { adapterFor, publicModels, voiceConfigs } from "./providers.ts";
const configs = voiceConfigs({
  DASHSCOPE_API_KEY: "q-secret",
  DASHSCOPE_WORKSPACE_ID: "workspace",
  GEMINI_API_KEY: "g-secret",
  OPENAI_REALTIME_API_KEY: "o-secret",
});
test("catalog preserves its default selection and never exposes credentials", () => {
  const models = publicModels(configs);
  expect(models.map((m) => m.id)).toEqual([
    "qwen",
    "qwen-omni-3.5-flash",
    "qwen-omni-3.5-plus",
    "qwen-audio-3.1-plus",
    "qwen-audio-3.0-plus",
    "qwen-audio-3.0-flash",
    "gemini",
    "openai",
  ]);
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
  expect(setup.session.tools[0].function.name).toBe("ask_sushii");
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
  const a = adapterFor(configs.find((c) => c.id === "openai")!);
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
  const a = adapterFor(configs.find((c) => c.id === "gemini")!);
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
test("input transcript deltas, revised snapshots and final text preserve their semantics", () => {
  for (const config of [configs[0]!, configs.find((c) => c.id === "openai")!]) {
    const adapter = adapterFor(config);
    expect(
      adapter.events({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "u1",
        delta: "Check my ",
      }),
    ).toEqual([
      {
        type: "transcript",
        role: "user",
        text: "Check my ",
        final: false,
        itemId: "u1",
      },
    ]);
    expect(
      adapter.events({
        type: "conversation.item.input_audio_transcription.text",
        item_id: "u1",
        text: "Check my calendar",
      }),
    ).toEqual([
      {
        type: "transcript",
        role: "user",
        text: "Check my calendar",
        final: false,
        replace: true,
        interim: true,
        itemId: "u1",
      },
    ]);
    expect(
      adapter.events({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Check my calendar.",
      }),
    ).toEqual([
      {
        type: "transcript",
        role: "user",
        text: "Check my calendar.",
        final: true,
        replace: true,
        itemId: "u1",
      },
    ]);
  }
  const gemini = adapterFor(configs.find((c) => c.id === "gemini")!);
  expect(
    gemini.events({
      serverContent: {
        interimInputTranscription: { text: "Check my calender" },
      },
    }),
  ).toEqual([
    {
      type: "transcript",
      role: "user",
      text: "Check my calender",
      final: false,
      interim: true,
    },
  ]);
  expect(
    gemini.events({
      serverContent: {
        inputTranscription: { text: "Check my calendar", finished: false },
      },
    }),
  ).toEqual([
    {
      type: "transcript",
      role: "user",
      text: "Check my calendar",
      final: false,
    },
  ]);
  expect(
    gemini.events({
      serverContent: { inputTranscription: { finished: true } },
    }),
  ).toEqual([{ type: "transcript", role: "user", text: "", final: true }]);
});

test("Qwen text and stash form one revised snapshot rather than an appended delta", () => {
  const a = adapterFor(configs[0]!);
  for (const type of [
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.text",
  ]) {
    expect(
      a.events({ type, item_id: "u", text: "Check my ", stash: "calendar" }),
    ).toEqual([
      {
        type: "transcript",
        role: "user",
        text: "Check my calendar",
        final: false,
        replace: true,
        interim: true,
        itemId: "u",
      },
    ]);
  }
});

test("every Qwen selection uses matching session fields and supports tool handoff", () => {
  const qwen = configs.filter((c) => c.provider === "qwen");
  expect(qwen).toHaveLength(6);
  expect(new Set(configs.map((c) => c.id)).size).toBe(configs.length);
  for (const config of qwen) {
    const adapter = adapterFor(config);
    expect(new URL(adapter.url).searchParams.get("model")).toBe(config.model);
    const session = (adapter.setup() as any).session;
    if (config.model.startsWith("qwen-audio-")) {
      expect(session.voice).toBe(config.voice);
      expect(session.turn_detection).toEqual({ type: "smart_turn" });
      expect(session.tools[0].function.name).toBe("ask_sushii");
      expect(session.audio).toBeUndefined();
    } else if (config.model.startsWith("qwen3.5-")) {
      expect(session.voice).toBe("Ethan");
      expect(session.input_audio_format).toBe("pcm");
      expect(session.turn_detection.type).toBe("semantic_vad");
      expect(session.tools[0].function.name).toBe("ask_sushii");
      expect(session.audio).toBeUndefined();
    } else {
      expect(session.audio.output.voice).toBe("Tina");
      expect(session.tools[0].function.name).toBe("ask_sushii");
    }
    expect(adapter.toolResult("call", "done")[1]).toEqual({
      type: "response.create",
    });
    expect(
      adapter.events({ type: "input_audio_buffer.speech_started" }),
    ).toEqual([{ type: "interrupted" }]);
    expect(
      adapter.events({
        type: "response.function_call_arguments.done",
        call_id: "call",
        name: "ask_sushii",
        arguments: '{"request":"help"}',
      }),
    ).toEqual([
      {
        type: "tool",
        id: "call",
        name: "ask_sushii",
        args: { request: "help" },
      },
    ]);
  }
});
test("Qwen models share credentials but use separate voice settings and regional prices", () => {
  const beijing = voiceConfigs({
    DASHSCOPE_REGION: "cn-beijing",
    DASHSCOPE_API_KEY: "key",
    DASHSCOPE_WORKSPACE_ID: "workspace",
    QWEN_VOICE: "Tina",
    QWEN_OMNI_35_VOICE: "Ethan",
    QWEN_AUDIO_31_VOICE: "beth_v3.1",
    QWEN_AUDIO_30_VOICE: "longanlingxin",
  }).filter((c) => c.provider === "qwen");
  expect(
    beijing.every((c) => c.configured && c.url.includes("cn-beijing")),
  ).toBe(true);
  expect(beijing.map((c) => [c.audioInputUsd, c.audioOutputUsd])).toEqual([
    [0.848, 1.696],
    [3.71, 14.71],
    [11, 41.26],
    [5.501, 20.628],
    [5.501, 20.628],
    [0.848, 1.696],
  ]);
  expect(beijing.map((c) => c.voice)).toEqual([
    "Tina",
    "Ethan",
    "Ethan",
    "beth_v3.1",
    "longanlingxin",
    "longanlingxin",
  ]);
  expect(
    voiceConfigs({})
      .filter((c) => c.provider === "qwen")
      .every((c) => !c.configured),
  ).toBe(true);
});

test("completed assistant transcripts replace streamed text, including done-only speech responses", () => {
  for (const config of configs.filter((c) => c.provider !== "gemini")) {
    expect(
      adapterFor(config).events({
        type: "response.audio_transcript.done",
        transcript: "I will check.",
      }),
    ).toEqual([
      {
        type: "transcript",
        role: "assistant",
        text: "I will check.",
        final: true,
        replace: true,
      },
    ]);
  }
});
