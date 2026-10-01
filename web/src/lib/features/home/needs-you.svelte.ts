import { HttpError } from '$lib/core/http';
import { hub as appHub, type Hub } from '$lib/core/realtime/hub.svelte';
import { Remote } from '$lib/core/remote.svelte';
import { chatApi, type ChatApi } from '$lib/features/chat';
import type { HomeApi } from './api';
import { fixtureHomeApi } from './fake';
import { applyLive, emptyLive, homeItems, type LiveState, type LocalState } from './needs-you';
import type { HomeData, HomeGroups } from './types';

export interface HomeDeps {
	hub?: Hub;
	api?: HomeApi;
	chat?: () => ChatApi;
}

type Result = { ok: boolean; text: string };

function failureText(err: unknown, what: 'decision' | 'answer'): string {
	const status = err instanceof HttpError ? err.status : 0;
	if (status === 403) return "This device isn't signed in as the owner.";
	if (status === 0) return `Couldn't send your ${what}. Check your connection and try again.`;
	return `The agent couldn't take your ${what}. Try again.`;
}

/** Home: what is waiting on you, what failed, what is running and what is ready to look at. */
export class NeedsYouStore {
	live = $state.raw<LiveState>(emptyLive());
	data: Remote<HomeData>;
	local = $state.raw<LocalState>({ dismissed: [], opened: [], asks: {} });
	/** Approvals with a decision in flight from Home. */
	submitting = $state.raw<readonly string[]>([]);
	/** What happened to the last thing done from Home, by item id. */
	results = $state.raw<Readonly<Record<string, Result>>>({});

	groups: HomeGroups = $derived.by(() => homeItems(this.live, this.data.data, this.local));
	waitingCount = $derived(this.groups.waiting.length);

	#hub: Hub;
	#api: HomeApi;
	#chat: () => ChatApi;
	#stop: (() => void) | null = null;

	constructor(deps: HomeDeps = {}) {
		this.#hub = deps.hub ?? appHub;
		this.#api = deps.api ?? fixtureHomeApi;
		this.#chat = deps.chat ?? chatApi;
		this.data = new Remote(() => this.#api.load(), { refetchOnFocus: true });
	}

	/** Listens to the stream for the app's life; the tab badge needs it on every screen. */
	start() {
		if (this.#stop) return;
		this.#stop = this.#hub.subscribe(
			{
				conversation: 'main',
				types: ['ask', 'ask_resolved', 'snapshot', 'tool', 'turn_final'],
				globals: ['approval', 'approval_resolved']
			},
			(batch) => {
				let next = this.live;
				for (const ev of batch) next = applyLive(next, ev);
				if (next !== this.live) this.live = next;
			}
		);
		this.#hub.start();
	}

	/** Loads the server part once; the stream part is already live. */
	open() {
		this.start();
		void this.data.ensure();
	}

	#result(id: string, result: Result | null) {
		const next = { ...this.results };
		if (result) next[id] = result;
		else delete next[id];
		this.results = next;
	}

	async decide(nonce: string, decision: 'approve' | 'deny') {
		const id = `approval:${nonce}`;
		if (this.submitting.includes(nonce)) return;
		this.submitting = [...this.submitting, nonce];
		this.#result(id, null);
		try {
			const r = await this.#chat().decide(nonce, { decision });
			this.#result(
				id,
				r.status === 'expired'
					? { ok: false, text: 'That approval had already expired, so it did not run.' }
					: decision === 'approve'
						? { ok: true, text: 'Approved. The agent carries on.' }
						: { ok: true, text: "Denied. The agent won't run it." }
			);
		} catch (err) {
			const gone = err instanceof HttpError && err.status === 404;
			this.#result(id, {
				ok: false,
				text: gone
					? 'That approval is no longer waiting for a decision.'
					: failureText(err, 'decision')
			});
		} finally {
			this.submitting = this.submitting.filter((n) => n !== nonce);
		}
	}

	#ask(askId: string, state: LocalState['asks'][string] | null) {
		const asks = { ...this.local.asks };
		if (state) asks[askId] = state;
		else delete asks[askId];
		this.local = { ...this.local, asks };
	}

	async answer(askId: string, answer: string, index?: number) {
		const id = `ask:${askId}`;
		this.#result(id, null);
		this.#ask(askId, { state: 'answering', answer });
		try {
			const r = await this.#chat().answerAsk(
				askId,
				index === undefined ? { text: answer } : { index, label: answer }
			);
			if (r.status === 'failed') throw new HttpError(502, 'failed');
			if (r.status === 'inactive') {
				this.#ask(askId, null);
				this.#result(id, { ok: false, text: 'That question is no longer waiting for an answer.' });
				return;
			}
			this.#ask(askId, { state: 'answered', answer });
			this.#result(id, { ok: true, text: 'Sent. The agent has your answer.' });
		} catch (err) {
			this.#ask(askId, null);
			const gone = err instanceof HttpError && err.status === 404;
			this.#result(id, {
				ok: false,
				text: gone
					? 'That question is no longer waiting for an answer.'
					: failureText(err, 'answer')
			});
		}
	}

	async dismiss(id: string) {
		this.local = { ...this.local, dismissed: [...this.local.dismissed, id] };
		try {
			await this.#api.dismiss(id);
		} catch {
			this.local = { ...this.local, dismissed: this.local.dismissed.filter((d) => d !== id) };
			this.#result(id, { ok: false, text: "Couldn't dismiss it. Try again." });
		}
	}

	/** Opening a finished run takes it off "Ready for review". */
	markOpened(runId: string) {
		const id = `run:${runId}`;
		if (!this.local.opened.includes(id)) {
			this.local = { ...this.local, opened: [...this.local.opened, id] };
		}
	}

	clearResult(id: string) {
		this.#result(id, null);
	}
}

let store: NeedsYouStore | null = null;
let configured: HomeDeps = {};

/** Swaps in other dependencies, for tests; call before the first store. */
export function configureHome(deps: HomeDeps) {
	configured = deps;
}

export function needsYou(): NeedsYouStore {
	return (store ??= new NeedsYouStore(configured));
}
