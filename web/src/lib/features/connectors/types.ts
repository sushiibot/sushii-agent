// View models for MCP connectors. Needs P1's runtime MCP; this is what the bot will serve.

export interface McpTool {
	/** As the server names it; third-party text, shown as plain text. */
	name: string;
	description: string;
	/** Changed since the snapshot you accepted. */
	change?: 'added' | 'removed';
}

export interface McpServerSummary {
	id: string;
	name: string;
	url: string;
	status: 'connected' | 'error' | 'signed-out';
	/** What went wrong, for `error` and `signed-out`. */
	problem?: string;
	tools: number;
	/** The server's tool list differs from the saved snapshot. */
	changed: boolean;
}

export interface McpServer extends McpServerSummary {
	snapshotAt: string;
	toolList: McpTool[];
	history: { at: string; event: string }[];
	usedBy: { runId: string; title: string; tool: string; at: string }[];
}

/** The add-by-URL flow: paste the address, sign in, paste the redirect back. */
export type AddStage = 'url' | 'oauth' | 'paste';

export interface AddState {
	stage: AddStage;
	url: string;
	/** The sign-in link the server handed back, for `oauth`. */
	authUrl?: string;
	/** The server's own name, once known. */
	name?: string;
	redirect: string;
	busy: boolean;
	error: string | null;
}
