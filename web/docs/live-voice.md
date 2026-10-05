# Live voice

Use the **Voice chat** phone button at the top right in the owner web app.
Choose a configured voice model, then select **Start voice chat** and allow microphone access.
The setup sheet closes when the call connects. A compact bar below the header shows the call state,
time, microphone control, caption toggle, and **End call**. Chat messages, tools, and approvals stay visible.
You can interrupt spoken replies. Open the phone button to review settings; **Back to chat** keeps the call open.

Captions show your speech and the spoken reply while the call runs. Captions reuse the chat message layout, with a **Voice** label and microphone or speaker icon below each message.
Partial text is muted and italic, and returns to normal styling when the provider finalizes it.
The empty-thread greeting disappears once voice text arrives. Providers control transcript timing; some text arrives only after a pause.
The adapters accept input transcript deltas, interim revisions, and completed text where the provider sends them.
Captions show the latest exchange and do not replace durable chat messages.
**End call**, navigation, a hidden page, or the 15-minute limit ends the call and releases the microphone.
Dictate remains available outside calls. During a call, the live session owns the microphone.

## Provider setup

Set credentials on the bot server through its secret configuration. Never put keys in browser code.

| Voice model                   | Model ID                        | Required environment variables                |
| ----------------------------- | ------------------------------- | --------------------------------------------- |
| Qwen Omni 3.8 Flash Realtime  | `qwen3.8-omni-flash-realtime`   | `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID` |
| Qwen Omni 3.5 Flash Realtime  | `qwen3.5-omni-flash-realtime`   | Same Qwen credentials                         |
| Qwen Omni 3.5 Plus Realtime   | `qwen3.5-omni-plus-realtime`    | Same Qwen credentials                         |
| Qwen Audio 3.1 Plus Realtime  | `qwen-audio-3.1-realtime-plus`  | Same Qwen credentials                         |
| Qwen Audio 3.0 Plus Realtime  | `qwen-audio-3.0-realtime-plus`  | Same Qwen credentials                         |
| Qwen Audio 3.0 Flash Realtime | `qwen-audio-3.0-realtime-flash` | Same Qwen credentials                         |
| Gemini 3.8 Live               | `gemini-3.8-live`               | `GEMINI_API_KEY`                              |
| OpenAI Realtime 2.1 Mini      | `gpt-realtime-2.1-mini`         | `OPENAI_REALTIME_API_KEY`                     |

[Qwen Audio Realtime](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-realtime-user-guides)
models specialize in full-duplex speech with audio and text input.
[Qwen Omni Realtime](https://www.alibabacloud.com/help/en/model-studio/realtime)
models also support multimodal input. The app sends microphone audio only for every model.
The picker uses stable model aliases rather than listing duplicate dated snapshots.
Older Qwen3 Omni Realtime models are excluded because they do not support the required tool handoff.

Qwen defaults to Singapore (`DASHSCOPE_REGION=ap-southeast-1`). Beijing (`cn-beijing`) is also supported.
The API key must belong to the selected region and workspace.
Optional voice settings are `QWEN_VOICE` (Tina, Omni 3.8),
`QWEN_OMNI_35_VOICE` (Ethan, Omni 3.5),
`QWEN_AUDIO_31_VOICE` (longanqian_v3.1, Audio 3.1),
`QWEN_AUDIO_30_VOICE` (longanqian, Audio 3.0),
`GEMINI_VOICE` (Kore), and `OPENAI_REALTIME_VOICE` (marin).
Each Qwen family has its own voice setting because supported voice IDs differ.

The first configured model in this table becomes the default. Each model remains selectable.
OpenAI uses a dedicated key because the bot's existing `OPENAI_API_KEY` may belong to OpenRouter.
A ChatGPT subscription does not provide Realtime API access for this custom web app.

Published audio prices checked on October 5, 2026, in USD per million audio tokens:

| Voice model                   | Singapore input | Singapore output | Beijing input | Beijing output |
| ----------------------------- | --------------: | ---------------: | ------------: | -------------: |
| Qwen Omni 3.8 Flash Realtime  |            0.93 |             1.87 |         0.848 |          1.696 |
| Qwen Omni 3.5 Flash Realtime  |             4.5 |             17.7 |          3.71 |          14.71 |
| Qwen Omni 3.5 Plus Realtime   |            16.5 |               62 |            11 |          41.26 |
| Qwen Audio 3.1 Plus Realtime  |             6.4 |               24 |         5.501 |         20.628 |
| Qwen Audio 3.0 Plus Realtime  |             6.4 |               24 |         5.501 |         20.628 |
| Qwen Audio 3.0 Flash Realtime |            0.93 |             1.87 |         0.848 |          1.696 |

Gemini Live audio input/output costs $3/$12 per million tokens.
OpenAI Realtime Mini audio input/output costs $10/$20 per million tokens.
Qwen prices come from each model's official Model Studio page:
[Omni 3.8 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime),
[Omni 3.5 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-omni-flash-realtime),
[Omni 3.5 Plus](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-omni-plus-realtime),
[Audio 3.1 Plus](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-3-1-realtime-plus),
[Audio 3.0 Plus](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-3-0-realtime-plus), and
[Audio 3.0 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-3-0-realtime-flash).

Token rates differ between providers. These prices do not give an equal per-minute comparison.
Text, transcription, repeated context, and the existing agent can add charges. Muting does not end billing.
Gemini compresses session context. All calls have a 15-minute limit and bounded audio buffers.
Check current [Qwen pricing](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), and
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) before use.

## Tools and architecture

All adapters expose `ask_sushii`. It submits the spoken request through the same durable input route as typed chat.
The existing agent owns tools, memory, conversation isolation, and approvals.
The voice model receives an immediate acknowledgment while the agent works.
The relay announces the matching result after speech and playback finish.
Approvals remain in the web chat. Ending a call stops its result listener; an accepted agent request can continue.

The browser sends PCM audio through an authenticated WebSocket on the existing web gateway.
Provider keys and protocol differences stay on the server.
The relay accepts audio and playback acknowledgments only; clients cannot change provider instructions or tool definitions.
One owner call can run at a time. The gateway verifies the owner and the WebSocket Origin before upgrading.

The [Qwen audio agent reference](https://github.com/QwenAudio/qwen-audio-agent) informed the separation between
voice, coordination, and backend work. It also showed why Qwen response creation needs a queue and Gemini tool results resume automatically.
The implementation uses its own adapters and the existing Sushii agent rather than another agent runtime.

The Qwen adapter uses nested audio configuration for Omni 3.8, flat PCM configuration for Omni 3.5,
and speech-specific configuration with `smart_turn` detection for Audio Realtime.
All Qwen tools use nested function definitions.

Protocol tests cover the model catalog, regional prices, family-specific setup, tools, duplicate requests, interruptions, and result scheduling.
Browser tests cover audio capture, playback, mute, ending calls, and missing credentials.
These checks use simulated providers. Real provider validation requires provisioned API credentials.
