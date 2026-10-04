import { HttpError, request } from '$lib/core/http';
import type { BrowserPreviewFrame, BrowserPreviewStatus } from './preview-types';

// Hiding survives navigation within the app, but never hides a different browser task.
const hiddenTasks = new Set<string>();

export class BrowserPreview {
	status = $state<BrowserPreviewStatus | null>(null);
	frame = $state<BrowserPreviewFrame | null>(null);
	hidden = $state(false);
	expanded = $state(false);
	reconnecting = $state(false);
	stale = $state(false);
	#socket: WebSocket | null = null;
	#timer?: ReturnType<typeof setTimeout>;
	#finishTimer?: ReturnType<typeof setTimeout>;
	#running = false;
	#abort?: AbortController;
	#lastFrameAt = 0;
	#fps = 5;
	#retryAt = 0;
	#pendingAck: number | null = null;
	constructor(readonly conversation: string) {}

	#apply(status: BrowserPreviewStatus | null) {
		if (status && status.conversationId !== this.conversation) return;
		if (status?.id !== this.status?.id) {
			this.#disconnect();
			// Retain an ended frame in an expanded viewer until the user dismisses it.
			if (!status && this.expanded && this.status?.state === 'ended') return;
			this.frame = null;
			this.hidden = status ? hiddenTasks.has(status.id) : false;
			clearTimeout(this.#finishTimer);
		}
		const ended = status?.state === 'ended' && this.status?.state !== 'ended';
		this.status = status;
		if (ended) {
			this.reconnecting = false;
			this.stale = false;
			this.#disconnect();
			this.#finishTimer = setTimeout(() => {
				if (!this.expanded) {
					this.hidden = true;
					this.frame = null;
				}
			}, 5000);
		}
	}

	start() {
		this.#running = true;
		const visibility = () => {
			if (document.hidden) this.#disconnect();
			else {
				this.#retryAt = 0;
				void this.#poll();
			}
		};
		document.addEventListener('visibilitychange', visibility);
		void this.#poll();
		return () => {
			this.#running = false;
			clearTimeout(this.#timer);
			clearTimeout(this.#finishTimer);
			this.#abort?.abort();
			this.#disconnect();
			document.removeEventListener('visibilitychange', visibility);
		};
	}

	async #poll() {
		clearTimeout(this.#timer);
		if (!this.#running || document.hidden || this.#abort) return;
		const abort = new AbortController();
		this.#abort = abort;
		try {
			const data = await request<{ status: BrowserPreviewStatus | null }>(
				'GET',
				`/browser/status?conversation=${encodeURIComponent(this.conversation)}`,
				undefined,
				{ signal: abort.signal }
			);
			if (!this.#running) return;
			this.#apply(data.status);
			this.#sync();
		} catch (error) {
			if (!this.#running) return;
			if (this.status?.state !== 'ended') this.reconnecting = !!this.status;
			if (error instanceof HttpError && [403, 404, 501].includes(error.status)) {
				this.#disconnect();
				return;
			}
		} finally {
			this.#abort = undefined;
			if (this.#running) this.#timer = setTimeout(() => void this.#poll(), 1000);
		}
		if (this.frame && this.status?.state !== 'ended')
			this.stale = Date.now() - this.#lastFrameAt > 5000;
	}

	#sync() {
		if (
			!this.#running ||
			document.hidden ||
			(this.hidden && !this.expanded) ||
			!this.status ||
			this.status.state === 'ended'
		) {
			this.#disconnect();
			return;
		}
		const fps = this.expanded ? 15 : 5;
		if (this.#socket && this.#fps !== fps) this.#disconnect();
		if (this.#socket || Date.now() < this.#retryAt) return;
		this.#fps = fps;
		const url = new URL(
			`/api/browser/connect?conversation=${encodeURIComponent(this.conversation)}&fps=${fps}`,
			location.href
		);
		url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const socket = new WebSocket(url);
		this.#socket = socket;
		socket.onmessage = (event) => {
			if (this.#socket !== socket || typeof event.data !== 'string' || event.data.length > 600_000)
				return;
			try {
				const msg = JSON.parse(event.data);
				if (msg.type === 'status') {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
					this.#lastFrameAt = Date.now();
					this.stale = false;
					this.#apply(msg.status);
				}
				if (
					msg.type === 'frame' &&
					msg.id === this.status?.id &&
					typeof msg.data === 'string' &&
					/^[A-Za-z0-9+/]*={0,2}$/.test(msg.data) &&
					Number.isSafeInteger(msg.seq) &&
					msg.width > 0 &&
					msg.width <= 4096 &&
					msg.height > 0 &&
					msg.height <= 4096
				) {
					this.#pendingAck = msg.seq;
					if (this.frame?.data === msg.data) this.ack(msg.seq);
					this.frame = {
						seq: msg.seq,
						data: msg.data,
						width: msg.width,
						height: msg.height,
						capturedAt: msg.capturedAt
					};
					this.#lastFrameAt = Date.now();
					this.reconnecting = false;
					this.stale = false;
				}
			} catch {
				socket.close();
			}
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			if (this.status?.state !== 'ended') this.reconnecting = true;
			this.#retryAt = Date.now() + 1500;
		};
		socket.onerror = () => socket.close();
	}

	#disconnect() {
		const socket = this.#socket;
		this.#socket = null;
		this.#pendingAck = null;
		socket?.close();
	}
	ack(seq: number) {
		if (this.#socket?.readyState === WebSocket.OPEN && this.#pendingAck === seq) {
			this.#pendingAck = null;
			this.#socket.send(JSON.stringify({ type: 'ack', seq }));
		}
	}
	hide() {
		this.hidden = true;
		if (this.status) {
			hiddenTasks.add(this.status.id);
			if (hiddenTasks.size > 100) hiddenTasks.delete(hiddenTasks.values().next().value!);
		}
		this.#sync();
	}
	show() {
		this.hidden = false;
		if (this.status) hiddenTasks.delete(this.status.id);
		this.#retryAt = 0;
		this.#sync();
	}
	setExpanded(expanded: boolean) {
		this.expanded = expanded;
		if (!expanded && this.status?.state === 'ended') {
			this.hidden = true;
			this.frame = null;
		}
		this.#retryAt = 0;
		this.#sync();
	}
}
