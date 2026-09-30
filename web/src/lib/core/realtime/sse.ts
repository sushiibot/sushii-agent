import type { ChatEnvelope } from './events';

export interface SseFrame {
	event: string;
	data: string;
	id?: string;
}

/** Incremental text/event-stream parser: feed decoded chunks, get whole frames back. */
export class SseParser {
	#buf = '';
	#event = '';
	#data: string[] = [];
	#id: string | undefined;

	push(chunk: string): SseFrame[] {
		this.#buf += chunk;
		const out: SseFrame[] = [];
		let nl: number;
		while ((nl = this.#buf.search(/\r\n|\r|\n/)) !== -1) {
			const line = this.#buf.slice(0, nl);
			const sep = this.#buf[nl] === '\r' && this.#buf[nl + 1] === '\n' ? 2 : 1;
			// A lone \r at the end of the buffer may be the first half of \r\n.
			if (this.#buf[nl] === '\r' && nl + 1 === this.#buf.length) break;
			this.#buf = this.#buf.slice(nl + sep);
			if (line === '') {
				if (this.#data.length) {
					out.push({ event: this.#event || 'message', data: this.#data.join('\n'), id: this.#id });
				}
				this.#event = '';
				this.#data = [];
				this.#id = undefined;
				continue;
			}
			if (line.startsWith(':')) continue;
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) value = value.slice(1);
			if (field === 'event') this.#event = value;
			else if (field === 'data') this.#data.push(value);
			else if (field === 'id' && !value.includes('\0')) this.#id = value;
		}
		return out;
	}
}

/** Decodes a frame into a chat envelope; null for anything malformed. */
export function toEnvelope(frame: SseFrame): ChatEnvelope | null {
	let data: unknown;
	try {
		data = JSON.parse(frame.data);
	} catch {
		return null;
	}
	if (data === null || typeof data !== 'object') return null;
	const seq = frame.id !== undefined && /^\d+$/.test(frame.id) ? Number(frame.id) : undefined;
	return { type: frame.event, data, ...(seq !== undefined ? { seq } : {}) } as ChatEnvelope;
}
