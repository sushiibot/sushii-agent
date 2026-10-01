import { enc, featureHttp } from '$lib/core/feature-http';
import type { McpServer, McpServerSummary } from './types';

export interface ConnectorsApi {
	list(): Promise<McpServerSummary[]>;
	/** null: no such server. */
	get(id: string): Promise<McpServer | null>;
	/** Accepts the server's current tool list as the new snapshot. */
	acceptTools(id: string): Promise<McpServer>;
	/** Checks the server and starts its sign-in; resolves to its name and the link to open. */
	begin(url: string, token?: string): Promise<{ name: string; authUrl: string } | McpServer>;
	/** Finishes sign-in with the address the browser landed on. */
	action?(
		id: string,
		action: 'reconnect' | 'disconnect' | 'remove'
	): Promise<McpServer | { removed: true }>;
	finish(url: string, redirect: string): Promise<McpServer>;
}

const http = featureHttp("Connectors aren't available yet.");

export const httpConnectorsApi: ConnectorsApi = {
	list: () => http.get('/connectors'),
	get: (id) => http.find(`/connectors/${enc(id)}`),
	acceptTools: (id) => http.post(`/connectors/${enc(id)}/accept`),
	begin: (url, token) => http.post('/connectors/begin', { url, ...(token ? { token } : {}) }),
	action: (id, action) => http.post(`/connectors/${enc(id)}/${action}`),
	finish: (url, redirect) => http.post('/connectors/finish', { url, redirect })
};
