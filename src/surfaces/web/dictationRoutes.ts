import { TranscriptionError, type TranscribableAudio } from "../../agent/transcribe.ts";
import { getLogger } from "../../logger.ts";
import { json, readBodyCapped } from "./http.ts";
import type { RequestTimeouts } from "./server.ts";

const log = getLogger("web/dictation");

/** About 30 minutes of the Opus a phone records; the app stops a recording well before that. */
export const DICTATION_MAX_BYTES = 8 * 1024 * 1024;
/** Longer than a 5-minute clip takes to transcribe; the connection's idle timeout is lifted to match. */
export const DICTATION_TIMEOUT_MS = 90_000;

/** What browsers' MediaRecorder produces, by the file extension the transcription endpoint expects. */
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export interface DictationRoutes {
  /** Null for a path outside /api/dictation. */
  handle(req: Request, path: string, server?: RequestTimeouts): Promise<Response | null>;
}

/** POST /api/dictation with the recorded audio as the body → {text}. 422 when no words came out of it,
 *  502 when the transcription itself failed. */
export function createDictationRoutes(deps: { transcribe: (audio: TranscribableAudio, signal: AbortSignal) => Promise<string | null> }): DictationRoutes {
  return {
    async handle(req, path, server) {
      if (path !== "/api/dictation") return null;
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const mediaType = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
      const ext = AUDIO_TYPES[mediaType];
      if (!ext) return json({ error: "unsupported audio type" }, 415);
      const length = req.headers.get("Content-Length");
      if (length !== null && !(/^\d+$/.test(length) && Number(length) <= DICTATION_MAX_BYTES)) return json({ error: "body too large" }, 413);
      const bytes = await readBodyCapped(req, DICTATION_MAX_BYTES);
      if (!bytes) return json({ error: "body too large" }, 413);
      if (!bytes.byteLength) return json({ error: "empty audio" }, 400);
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      server?.timeout(req, DICTATION_TIMEOUT_MS / 1000 + 10);
      // A client that gave up stops the paid request too, so a retry doesn't pay twice.
      const signal = AbortSignal.any([req.signal, AbortSignal.timeout(DICTATION_TIMEOUT_MS)]);
      let text: string | null;
      try {
        text = await deps.transcribe({ data, mediaType, filename: `dictation.${ext}` }, signal);
      } catch (err) {
        if (!(err instanceof TranscriptionError)) throw err;
        log.warn({ err }, "dictation transcription failed");
        return json({ error: "transcription_failed" }, 502);
      }
      return text ? json({ text }) : json({ error: "no_speech" }, 422);
    },
  };
}
