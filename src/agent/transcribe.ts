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
  return async (audio) => {
    try {
      return await transcribeAudio(audio);
    } catch (err) {
      logger.warn({ err }, "voice transcription failed");
      return null;
    }
  };
}

export class TranscriptionError extends Error {}

/** The transcript; null when the audio held no words. Throws TranscriptionError when the request
 *  failed, so a caller can tell "nothing said" from "try again". */
export async function transcribeAudio(audio: TranscribableAudio, signal?: AbortSignal): Promise<string | null> {
  const form = new FormData();
  form.append("file", new Blob([audio.data], { type: audio.mediaType }), audio.filename ?? "voice-message.ogg");
  form.append("model", config.transcriptionModel);
  let res: Response;
  try {
    res = await fetch(`${config.openaiBaseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      body: form,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new TranscriptionError(`transcription request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    logger.warn({ status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) }, "transcription request failed");
    throw new TranscriptionError(`transcription request failed: ${res.status}`);
  }
  const json = (await res.json().catch(() => null)) as { text?: string } | null;
  if (!json) throw new TranscriptionError("transcription answer was not JSON");
  const text = json.text?.trim();
  return text ? text : null;
}
