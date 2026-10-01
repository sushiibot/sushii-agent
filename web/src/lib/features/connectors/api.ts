import type { McpServer, McpServerSummary } from './types';

export interface ConnectorsApi {
	list(): Promise<McpServerSummary[]>;
	/** null: no such server. */
	get(id: string): Promise<McpServer | null>;
	/** Accepts the server's current tool list as the new snapshot. */
	acceptTools(id: string): Promise<McpServer>;
	/** Checks the server and starts its sign-in; resolves to its name and the link to open. */
	begin(url: string): Promise<{ name: string; authUrl: string }>;
	/** Finishes sign-in with the address the browser landed on. */
	finish(url: string, redirect: string): Promise<McpServer>;
}
