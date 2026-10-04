export interface BrowserPreviewStatus {
	id: string;
	conversationId: string;
	state: 'starting' | 'active' | 'ended';
	runId: string | null;
	url?: string;
	action: string;
	endedAt?: number;
}
export interface BrowserPreviewFrame {
	seq: number;
	data: string;
	width: number;
	height: number;
	capturedAt: number;
}
