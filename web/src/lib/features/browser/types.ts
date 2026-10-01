// The browser takeover's states. A placeholder until the browser runs in its own container behind
// the gateway; the live view, the field sheet and the lock are not built.

/** Who holds the browser: nobody, the agent, or you (and the agent is locked out). */
export type BrowserHolder = 'idle' | 'agent' | 'you';

export interface BrowserStatus {
	holder: BrowserHolder;
	/** The page's real address, never a title the page chose. */
	url?: string;
	/** Since when the current holder has it. */
	since?: string;
	/** What the agent was doing when it last held it. */
	task?: { runId: string; title: string };
}

/** Taking over or handing back is waiting on the gateway's lock. */
export type BrowserPending = 'taking' | 'handing' | null;
