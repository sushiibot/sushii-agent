import { Remote } from '$lib/core/remote.svelte';
import { httpConnectorsApi, type ConnectorsApi } from './api';
import type { AddState, ConnectorOperation, McpServer, McpServerSummary } from './types';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
const blank = (): AddState => ({ stage: 'url', url: '', redirect: '', busy: false, error: null });

export class ConnectorsStore {
	list: Remote<McpServerSummary[]>;
	busy = $state(false);
	error = $state<string | null>(null);
	operation = $state<{ id: string; kind: ConnectorOperation } | null>(null);
	errorOperation = $state<{ id: string; kind: ConnectorOperation } | null>(null);
	add = $state<AddState>(blank());
	/** The server just connected, so its screen can say so once. */
	justConnected = $state<string | null>(null);

	#api: ConnectorsApi;
	#servers = new Map<string, Remote<McpServer | null>>();

	constructor(api: ConnectorsApi = httpConnectorsApi) {
		this.#api = api;
		this.list = new Remote(() => api.list(), { refetchOnFocus: true });
	}

	server(id: string) {
		let r = this.#servers.get(id);
		if (!r) this.#servers.set(id, (r = new Remote(() => this.#api.get(id))));
		return r;
	}

	async acceptTools(id: string) {
		if (this.busy) return;
		this.busy = true;
		this.operation = { id, kind: 'snapshot' };
		this.errorOperation = null;
		this.error = null;
		try {
			this.server(id).data = await this.#api.acceptTools(id);
			void this.list.refetch();
		} catch (err) {
			this.error = errorText(err);
			this.errorOperation = this.operation;
		} finally {
			this.operation = null;
			this.busy = false;
		}
	}

	resetAdd() {
		this.add = blank();
	}

	/** Moves the add flow back a step, as its Back does. */
	stepBack() {
		this.add.error = null;
		this.add.errorField = undefined;
		this.add.stage = this.add.stage === 'paste' ? 'oauth' : 'url';
	}

	async begin(): Promise<string | null> {
		this.add.error = null;
		this.add.errorField = undefined;
		if (!/^https:\/\/[^/\s]+/i.test(this.add.url.trim())) {
			this.add.error = 'That isn’t an https:// address. Use an address starting with https://.';
			this.add.errorField = 'url';
			return null;
		}
		this.add.busy = true;
		try {
			const result = await this.#api.begin(
				this.add.url.trim(),
				this.add.token?.trim() || undefined
			);
			this.add.token = '';
			if ('id' in result) {
				this.server(result.id).data = result;
				this.justConnected = result.id;
				void this.list.refetch();
				this.add = blank();
				return result.id;
			}
			this.add = { ...this.add, name: result.name, authUrl: result.authUrl, stage: 'oauth' };
		} catch (err) {
			this.add.error = errorText(err);
		} finally {
			this.add.busy = false;
		}
		return null;
	}

	async action(id: string, action: 'reconnect' | 'disconnect' | 'remove'): Promise<boolean> {
		if (!this.#api.action || this.busy) return false;
		this.busy = true;
		this.operation = { id, kind: action };
		this.errorOperation = null;
		this.error = null;
		try {
			const result = await this.#api.action(id, action);
			if ('id' in result) this.server(id).data = result;
			else this.server(id).data = null;
			void this.list.refetch();
			return true;
		} catch (err) {
			this.error = errorText(err);
			this.errorOperation = this.operation;
			return false;
		} finally {
			this.operation = null;
			this.busy = false;
		}
	}

	signedIn() {
		this.add.stage = 'paste';
	}

	/** Resolves to the new server's id, or null with the error on the flow. */
	async finish(): Promise<string | null> {
		this.add.busy = true;
		this.add.error = null;
		try {
			const s = await this.#api.finish(this.add.url.trim(), this.add.redirect.trim());
			this.server(s.id).data = s;
			this.justConnected = s.id;
			void this.list.refetch();
			this.add = blank();
			return s.id;
		} catch (err) {
			this.add.error = errorText(err);
			return null;
		} finally {
			this.add.busy = false;
		}
	}
}

let store: ConnectorsStore | null = null;
let configured: ConnectorsApi | undefined;

export function configureConnectors(api: ConnectorsApi) {
	configured = api;
}

export function connectorsStore(): ConnectorsStore {
	return (store ??= new ConnectorsStore(configured));
}
