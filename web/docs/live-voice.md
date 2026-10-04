# Live voice

Use the **Voice chat** phone button at the top right in the owner web app.
Choose a configured provider, then select **Start voice chat** and allow microphone access.
The setup sheet closes when the call connects. A compact bar below the header shows the call state,
time, microphone control, caption toggle, and **End call**. Chat messages, tools, and approvals stay visible.
You can interrupt spoken replies. Open the phone button to review settings; **Back to chat** keeps the call open.

Captions show your speech and the spoken reply while the call runs. Partial text displays **Transcribing…**
and can change before the provider finalizes it. Providers control transcript timing; some text arrives only after a pause.
The adapters accept input transcript deltas, interim revisions, and completed text where the provider sends them.
Captions show the latest exchange and do not replace durable chat messages.
**End call**, navigation, a hidden page, or the 15-minute limit ends the call and releases the microphone.
Dictate remains available outside calls. During a call, the live session owns the microphone.

## Provider setup

Set credentials on the bot server through its secret configuration. Never put keys in browser code.

| Adapter | Model                         | Required environment variables                |
| ------- | ----------------------------- | --------------------------------------------- |
| Qwen    | `qwen3.8-omni-flash-realtime` | `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID` |
| Gemini  | `gemini-3.8-live`             | `GEMINI_API_KEY`                              |
| OpenAI  | `gpt-realtime-2.1-mini`       | `OPENAI_REALTIME_API_KEY`                     |

Qwen defaults to Singapore (`DASHSCOPE_REGION=ap-southeast-1`). Beijing (`cn-beijing`) is also supported.
The API key must belong to the selected region and workspace.
Optional voice settings are `QWEN_VOICE` (Tina), `GEMINI_VOICE` (Kore), and `OPENAI_REALTIME_VOICE` (marin).

The first configured provider in this table becomes the default. Each provider remains selectable.
OpenAI uses a dedicated key because the bot's existing `OPENAI_API_KEY` may belong to OpenRouter.
A ChatGPT subscription does not provide Realtime API access for this custom web app.

Published audio prices checked on October 4, 2026, in USD per million audio tokens:

| Provider             | Input | Output |
| -------------------- | ----: | -----: |
| Qwen, Singapore      |  0.93 |   1.87 |
| Qwen, Beijing        | 0.848 |  1.696 |
| Gemini Live          |     3 |     12 |
| OpenAI Realtime Mini |    10 |     20 |

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

Protocol tests cover setup, tools, duplicate requests, interruptions, and result scheduling.
Browser tests cover audio capture, playback, mute, ending calls, and missing credentials.
These checks use simulated providers. Real provider validation requires provisioned API credentials.
