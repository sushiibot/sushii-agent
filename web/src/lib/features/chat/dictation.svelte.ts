import type { DictationState } from './types';

export type { DictationState };

/** A recording stops itself here; the bot takes about half an hour of audio. */
export const DICTATION_MAX_SECONDS = 5 * 60;

// Chrome and Firefox record WebM/Opus, Safari MP4/AAC; the bot's transcriber takes either.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/** Sends recorded audio to the bot; resolves to the text, or throws a sentence for the owner. */
export type Transcribe = (audio: Blob, signal?: AbortSignal) => Promise<string>;

export const httpTranscribe: Transcribe = async (audio, signal) => {
	let res: Response;
	try {
		res = await fetch('/api/dictation', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': audio.type || 'audio/webm' },
			body: audio,
			signal
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new Error("Can't reach the agent. Check your connection.");
	}
	if (res.status === 422) throw new Error("Didn't catch any words. Try again.");
	if (res.status === 413)
		throw new Error('That recording was too long to send. Try a shorter one.');
	if (!res.ok) throw new Error("Couldn't turn that into text. Try again.");
	const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
	if (typeof body?.text !== 'string') throw new Error("Couldn't turn that into text. Try again.");
	return body.text;
};

/** Plenty for speech recognition, and keeps 5 minutes far under the bot's 8 MB cap. */
const BITS_PER_SECOND = 32_000;

/** Records from the microphone and turns it into text, like dictation on a phone keyboard. */
export class Dictation {
	state = $state<DictationState>('idle');
	seconds = $state(0);
	error = $state<string | null>(null);

	#transcribe: Transcribe;
	#ondone: (text: string) => void;
	#recorder: MediaRecorder | null = null;
	#stream: MediaStream | null = null;
	#chunks: Blob[] = [];
	#type = '';
	#timer: ReturnType<typeof setInterval> | null = null;
	/** Settles once the recorder has stopped, however it stopped. */
	#stopped: Promise<void> | null = null;
	#abort: AbortController | null = null;
	#onhidden = () => {
		if (document.visibilityState === 'hidden') this.#finish();
	};

	constructor(ondone: (text: string) => void, transcribe: Transcribe = httpTranscribe) {
		this.#ondone = ondone;
		this.#transcribe = transcribe;
	}

	/** Starts recording, or stops and transcribes what was recorded. */
	toggle() {
		if (this.state === 'idle') void this.#start();
		else if (this.state === 'recording') this.#finish();
	}

	/** Drops a recording or a transcription in progress; its text never lands. */
	cancel() {
		this.#abort?.abort();
		this.#abort = null;
		this.#teardown();
		this.state = 'idle';
	}

	async #start() {
		this.error = null;
		this.state = 'starting';
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			this.state = 'idle';
			this.error =
				err instanceof DOMException && err.name === 'NotAllowedError'
					? "Microphone access is off. Allow it in the browser's site settings, then try again."
					: "Couldn't start the microphone.";
			return;
		}
		this.#stream = stream;
		// Cancelled while the permission prompt was up.
		if (this.state !== 'starting') {
			this.#teardown();
			return;
		}
		try {
			const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
			const recorder = new MediaRecorder(stream, {
				...(type ? { mimeType: type } : {}),
				audioBitsPerSecond: BITS_PER_SECOND
			});
			this.#recorder = recorder;
			this.#chunks = [];
			this.#type = type ?? '';
			recorder.ondataavailable = (e) => {
				if (!e.data.size) return;
				this.#type ||= e.data.type;
				this.#chunks.push(e.data);
			};
			// The recorder can stop on its own (the track ended, a call came in): that ends the take too.
			this.#stopped = new Promise((resolve) => {
				recorder.onstop = recorder.onerror = () => {
					resolve();
					this.#finish();
				};
			});
			for (const t of stream.getAudioTracks()) t.onended = () => this.#finish();
			recorder.start();
		} catch {
			this.#teardown();
			this.state = 'idle';
			this.error = "Couldn't start recording on this device.";
			return;
		}
		this.seconds = 0;
		this.state = 'recording';
		document.addEventListener('visibilitychange', this.#onhidden);
		this.#timer = setInterval(() => {
			this.seconds++;
			if (this.seconds >= DICTATION_MAX_SECONDS) this.#finish();
		}, 1000);
	}

	/** Ends the take and transcribes it; a no-op unless recording. */
	#finish() {
		if (this.state !== 'recording') return;
		this.state = 'transcribing';
		void this.#transcribeTake();
	}

	async #transcribeTake() {
		const recorder = this.#recorder;
		const abort = new AbortController();
		this.#abort = abort;
		try {
			if (recorder && recorder.state !== 'inactive') recorder.stop();
			await this.#stopped;
			const audio = new Blob(this.#chunks, { type: this.#type || 'audio/webm' });
			this.#teardown();
			if (!audio.size) throw new Error("Didn't catch any words. Try again.");
			const text = (await this.#transcribe(audio, abort.signal)).trim();
			if (text && !abort.signal.aborted) this.#ondone(text);
		} catch (err) {
			if (!abort.signal.aborted) {
				this.error =
					err instanceof Error ? err.message : "Couldn't turn that into text. Try again.";
			}
		} finally {
			this.#teardown();
			if (this.#abort === abort) {
				this.#abort = null;
				this.state = 'idle';
			}
		}
	}

	#teardown() {
		document.removeEventListener('visibilitychange', this.#onhidden);
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		const recorder = this.#recorder;
		this.#recorder = null;
		if (recorder && recorder.state !== 'inactive') {
			try {
				recorder.stop();
			} catch {
				// Already stopping.
			}
		}
		for (const t of this.#stream?.getTracks() ?? []) t.stop();
		this.#stream = null;
	}
}
