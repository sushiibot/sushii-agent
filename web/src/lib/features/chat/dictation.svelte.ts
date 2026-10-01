import type { DictationState } from './types';

export type { DictationState };

/** A recording stops itself here; the bot takes about half an hour of audio. */
export const DICTATION_MAX_SECONDS = 5 * 60;

// Chrome and Firefox record WebM/Opus, Safari MP4/AAC; the bot's transcriber takes either.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/** Sends recorded audio to the bot; resolves to the text, or throws a sentence for the owner. */
export type Transcribe = (audio: Blob) => Promise<string>;

export const httpTranscribe: Transcribe = async (audio) => {
	let res: Response;
	try {
		res = await fetch('/api/dictation', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': audio.type || 'audio/webm' },
			body: audio
		});
	} catch {
		throw new Error("Can't reach the agent. Check your connection.");
	}
	if (res.status === 422) throw new Error("Didn't catch any words. Try again.");
	if (!res.ok) throw new Error("Couldn't turn that into text. Try again.");
	const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
	if (typeof body?.text !== 'string') throw new Error("Couldn't turn that into text. Try again.");
	return body.text;
};

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
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(ondone: (text: string) => void, transcribe: Transcribe = httpTranscribe) {
		this.#ondone = ondone;
		this.#transcribe = transcribe;
	}

	/** Starts recording, or stops and transcribes what was recorded. */
	toggle() {
		if (this.state === 'idle') void this.#start();
		else if (this.state === 'recording') void this.#finish();
	}

	/** Drops a recording in progress without transcribing it. */
	cancel() {
		this.#teardown();
		if (this.state === 'recording' || this.state === 'starting') this.state = 'idle';
	}

	async #start() {
		this.error = null;
		this.state = 'starting';
		try {
			this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			this.state = 'idle';
			this.error =
				err instanceof DOMException && err.name === 'NotAllowedError'
					? "Microphone access is off. Allow it in the browser's site settings, then try again."
					: "Couldn't start the microphone.";
			return;
		}
		// Cancelled while the permission prompt was up.
		if (this.state !== 'starting') {
			this.#teardown();
			return;
		}
		const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
		this.#recorder = new MediaRecorder(this.#stream, type ? { mimeType: type } : undefined);
		this.#chunks = [];
		this.#recorder.ondataavailable = (e) => {
			if (e.data.size) this.#chunks.push(e.data);
		};
		this.#recorder.start();
		this.seconds = 0;
		this.state = 'recording';
		this.#timer = setInterval(() => {
			this.seconds++;
			if (this.seconds >= DICTATION_MAX_SECONDS) void this.#finish();
		}, 1000);
	}

	async #finish() {
		const recorder = this.#recorder;
		if (!recorder || this.state !== 'recording') return;
		this.state = 'transcribing';
		const audio = await new Promise<Blob>((resolve) => {
			recorder.onstop = () =>
				resolve(new Blob(this.#chunks, { type: recorder.mimeType || 'audio/webm' }));
			recorder.stop();
		});
		this.#teardown();
		try {
			const text = (await this.#transcribe(audio)).trim();
			if (text) this.#ondone(text);
		} catch (err) {
			this.error = err instanceof Error ? err.message : "Couldn't turn that into text. Try again.";
		} finally {
			this.state = 'idle';
		}
	}

	#teardown() {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		if (this.#recorder?.state === 'recording') this.#recorder.stop();
		this.#recorder = null;
		for (const t of this.#stream?.getTracks() ?? []) t.stop();
		this.#stream = null;
	}
}
