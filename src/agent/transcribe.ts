import { config } from "../config.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("agent/transcribe");

export interface TranscribableAudio {
  data: ArrayBuffer;
  mediaType: string; // e.g. "audio/ogg"
  filename?: string;
}

/** Speech-to-text via OpenRouter's dedicated Whisper transcription endpoint (`/audio/transcriptions`,
 *  OpenAI-compatible multipart form), reusing the bot's OpenRouter key. A real ASR model, not an LLM —
 *  cheaper per second and more accurate than routing audio through a chat model. Returns the transcript,
 *  or null on failure / empty audio (callers treat null as "no usable text"). */
export function createTranscriber(): (audio: TranscribableAudio) => Promise<string | null> {
  const model = config.transcriptionModel;
  const url = `${config.openaiBaseUrl.replace(/\/$/, "")}/audio/transcriptions`;
  return async (audio) => {
    try {
      const form = new FormData();
      form.append("file", new Blob([audio.data], { type: audio.mediaType }), audio.filename ?? "voice-message.ogg");
      form.append("model", model);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        body: form,
      });
      if (!res.ok) {
        logger.warn({ status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) }, "transcription request failed");
        return null;
      }
      const json = (await res.json()) as { text?: string };
      const text = json.text?.trim();
      return text && text.length > 0 ? text : null;
    } catch (err) {
      logger.warn({ err }, "voice transcription failed");
      return null;
    }
  };
}
