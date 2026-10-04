/** Provider-specific protocols stay here; the browser only speaks our PCM/event protocol. */
export type VoiceProvider = "qwen" | "gemini" | "openai";
export interface VoiceModel {
  id: VoiceProvider;
  name: string;
  model: string;
  inputRate: number;
  audioInputUsd: number;
  audioOutputUsd: number;
  configured: boolean;
}
export interface VoiceConfig extends VoiceModel {
  key: string;
  url: string;
  voice: string;
}
export function voiceConfigs(
  env: Record<string, string | undefined>,
): VoiceConfig[] {
  const workspace = env.DASHSCOPE_WORKSPACE_ID?.trim() ?? "";
  if (workspace && !/^[a-zA-Z0-9-]+$/.test(workspace))
    throw new Error("Invalid DASHSCOPE_WORKSPACE_ID");
  const region = env.DASHSCOPE_REGION ?? "ap-southeast-1";
  if (!["ap-southeast-1", "cn-beijing"].includes(region))
    throw new Error("Invalid DASHSCOPE_REGION");
  return [
    {
      id: "qwen",
      name: "Qwen Omni Flash",
      model: "qwen3.8-omni-flash-realtime",
      inputRate: 16000,
      audioInputUsd: region === "cn-beijing" ? 0.848 : 0.93,
      audioOutputUsd: region === "cn-beijing" ? 1.696 : 1.87,
      key: env.DASHSCOPE_API_KEY ?? "",
      configured: !!env.DASHSCOPE_API_KEY && !!workspace,
      url: `wss://${workspace}.${region}.maas.aliyuncs.com/api-ws/v1/realtime`,
      voice: env.QWEN_VOICE ?? "Tina",
    },
    {
      id: "gemini",
      name: "Gemini Live",
      model: "gemini-3.8-live",
      inputRate: 16000,
      audioInputUsd: 3,
      audioOutputUsd: 12,
      key: env.GEMINI_API_KEY ?? "",
      configured: !!env.GEMINI_API_KEY,
      url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
      voice: env.GEMINI_VOICE ?? "Kore",
    },
    {
      id: "openai",
      name: "OpenAI Realtime Mini",
      model: "gpt-realtime-2.1-mini",
      inputRate: 24000,
      audioInputUsd: 10,
      audioOutputUsd: 20,
      key: env.OPENAI_REALTIME_API_KEY ?? "",
      configured: !!env.OPENAI_REALTIME_API_KEY,
      url: "wss://api.openai.com/v1/realtime",
      voice: env.OPENAI_REALTIME_VOICE ?? "marin",
    },
  ];
}
export function publicModels(configs: VoiceConfig[]): VoiceModel[] {
  return configs.map(
    ({ key: _key, url: _url, voice: _voice, ...model }) => model,
  );
}
export type VoiceEvent =
  | { type: "ready"; inputRate: number }
  | { type: "audio"; audio: string; sampleRate: number; responseId?: string }
  | {
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
      replace?: boolean;
      interim?: boolean;
      itemId?: string;
    }
  | { type: "interrupted" }
  | { type: "speech_end" }
  | { type: "response_started"; id: string }
  | { type: "turn_done" }
  | { type: "tool"; id: string; name: string; args: unknown }
  | { type: "tool_cancel"; ids: string[] }
  | { type: "error"; message: string };
const instructions =
  "You are Sushii's voice interface. Keep spoken answers concise. For every substantive user request, call ask_sushii with the user's request, then speak its answer. The existing Sushii agent owns memory, reasoning, tools and approvals. Never claim an action was completed without its result. Tell the user when a tool needs approval in the web chat. You may handle greetings and clarifications yourself.";
const tool = {
  name: "ask_sushii",
  description:
    "Ask the existing Sushii agent to answer or act using its memory and tools. Forward the user's request faithfully.",
  parameters: {
    type: "object",
    properties: { request: { type: "string" } },
    required: ["request"],
    additionalProperties: false,
  },
};
type Json = Record<string, any>;
export interface VoiceAdapter {
  url: string;
  headers: Record<string, string>;
  setup(): unknown;
  audio(data: string): unknown;
  toolResult(id: string, output: string): unknown[];
  result(text: string): unknown[];
  events(message: Json): VoiceEvent[];
}
export function adapterFor(c: VoiceConfig): VoiceAdapter {
  if (c.id === "gemini")
    return {
      url: `${c.url}?key=${encodeURIComponent(c.key)}`,
      headers: {},
      setup: () => ({
        setup: {
          model: `models/${c.model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice } },
            },
          },
          systemInstruction: { parts: [{ text: instructions }] },
          tools: [
            {
              functionDeclarations: [
                {
                  name: tool.name,
                  description: tool.description,
                  parameters: {
                    type: "OBJECT",
                    properties: { request: { type: "STRING" } },
                    required: ["request"],
                  },
                },
              ],
            },
          ],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: {
            triggerTokens: 12000,
            slidingWindow: { targetTokens: 6000 },
          },
        },
      }),
      audio: (data) => ({
        realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } },
      }),
      toolResult: (id, output) => [
        {
          toolResponse: {
            functionResponses: [
              { id, name: tool.name, response: { result: output } },
            ],
          },
        },
      ],
      result: (text) => [
        {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: `Sushii's background request finished. Speak this result concisely; do not call ask_sushii again for it:\n${text}`,
                  },
                ],
              },
            ],
            turnComplete: true,
          },
        },
      ],
      events: (m) => {
        const out: VoiceEvent[] = [];
        if (m.setupComplete)
          out.push({ type: "ready", inputRate: c.inputRate });
        const s = m.serverContent;
        if (s?.interrupted) out.push({ type: "interrupted" });
        for (const p of s?.interrupted ? [] : (s?.modelTurn?.parts ?? []))
          if (p.inlineData?.data)
            out.push({
              type: "audio",
              audio: p.inlineData.data,
              sampleRate: Number(
                p.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000,
              ),
            });
        const interim = s?.interimInputTranscription;
        if (typeof interim?.text === "string")
          out.push({
            type: "transcript",
            role: "user",
            text: interim.text,
            final: false,
            interim: true,
          });
        for (const [role, t] of [
          ["user", s?.inputTranscription],
          ["assistant", s?.outputTranscription],
        ] as const)
          if (typeof t?.text === "string" || t?.finished === true)
            out.push({
              type: "transcript",
              role,
              text: t.text ?? "",
              final: t.finished === true,
            });
        if (s?.turnComplete)
          out.push({ type: "speech_end" }, { type: "turn_done" });
        for (const f of m.toolCall?.functionCalls ?? [])
          out.push({ type: "tool", id: f.id, name: f.name, args: f.args });
        if (m.toolCallCancellation)
          out.push({
            type: "tool_cancel",
            ids: m.toolCallCancellation.ids ?? [],
          });
        if (m.error || m.goAway)
          out.push({
            type: "error",
            message: m.goAway
              ? "Voice session ended. Start a new call."
              : "Gemini voice request failed. Check the server credentials and quota.",
          });
        return out;
      },
    };
  const openai = c.id === "openai";
  return {
    url: `${c.url}?model=${encodeURIComponent(c.model)}`,
    headers: { Authorization: `Bearer ${c.key}` },
    setup: () => ({
      type: "session.update",
      session: openai
        ? {
            type: "realtime",
            model: c.model,
            output_modalities: ["audio"],
            instructions,
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "server_vad",
                  silence_duration_ms: 650,
                  interrupt_response: true,
                  create_response: true,
                },
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: c.voice,
              },
            },
            tools: [{ type: "function", ...tool }],
          }
        : {
            modalities: ["text", "audio"],
            instructions,
            input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
            audio: {
              input: {
                format: {
                  type: "pcm",
                  sample_rate: 16000,
                  sample_format: "s16le",
                  channels: 1,
                  packing: "interleaved",
                  channel_layout: "mono",
                },
              },
              output: {
                voice: c.voice,
                format: { type: "pcm", sample_rate: 24000 },
              },
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              silence_duration_ms: 650,
            },
            tools: [{ type: "function", ...tool }],
          },
    }),
    audio: (audio) => ({ type: "input_audio_buffer.append", audio }),
    toolResult: (call_id, output) => [
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output },
      },
      { type: "response.create" },
    ],
    result: (text) => [
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Sushii's background request finished. Speak this result concisely; do not call ask_sushii again for it:\n${text}`,
            },
          ],
        },
      },
      { type: "response.create", response: { tool_choice: "none" } },
    ],
    events: (m) => {
      switch (m.type) {
        case "session.updated":
          return [{ type: "ready", inputRate: c.inputRate }];
        case "response.audio.delta":
        case "response.output_audio.delta":
          return [
            {
              type: "audio",
              audio: m.delta,
              sampleRate: 24000,
              responseId: m.response_id,
            },
          ];
        case "input_audio_buffer.speech_started":
          return [{ type: "interrupted" }];
        case "input_audio_buffer.speech_stopped":
          return [{ type: "speech_end" }];
        case "response.created":
          return [{ type: "response_started", id: m.response?.id ?? "" }];
        case "conversation.item.input_audio_transcription.delta":
          return [
            {
              type: "transcript",
              role: "user",
              text:
                typeof m.text === "string"
                  ? m.text + (m.stash ?? "")
                  : (m.delta ?? ""),
              final: false,
              ...(typeof m.text === "string"
                ? { replace: true, interim: true }
                : {}),
              itemId: m.item_id,
            },
          ];
        case "conversation.item.input_audio_transcription.text":
          return [
            {
              type: "transcript",
              role: "user",
              text: (m.text ?? m.transcript ?? "") + (m.stash ?? ""),
              final: false,
              replace: true,
              interim: true,
              itemId: m.item_id,
            },
          ];
        case "conversation.item.input_audio_transcription.completed":
          return [
            {
              type: "transcript",
              role: "user",
              text: m.transcript,
              final: true,
              replace: true,
              itemId: m.item_id,
            },
          ];
        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta":
          return [
            {
              type: "transcript",
              role: "assistant",
              text: m.delta,
              final: false,
            },
          ];
        case "response.done":
          return m.response?.status === "failed"
            ? [
                {
                  type: "error",
                  message:
                    "Voice response failed. Check the provider quota and try again.",
                },
              ]
            : [{ type: "turn_done" }];
        case "response.function_call_arguments.done": {
          let args: unknown;
          try {
            args = JSON.parse(m.arguments);
          } catch {
            args = null;
          }
          return [{ type: "tool", id: m.call_id, name: m.name, args }];
        }
        case "error":
          return [
            {
              type: "error",
              message:
                "Voice provider request failed. Check the server credentials and quota.",
            },
          ];
        default:
          return [];
      }
    },
  };
}
