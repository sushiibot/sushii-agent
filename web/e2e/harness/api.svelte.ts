import type { ChatMessage, PendingApproval, TurnStep } from '$lib/features/chat/types';

export const pending = (nonce: string, tool = 'bash'): PendingApproval =>
	({
		nonce,
		view: {
			tool,
			agentId: 'a',
			agentName: 'agent',
			fields: [{ key: 'command', value: nonce, kind: 'single', max: 200 }]
		}
	}) as PendingApproval;

class Api {
	messages = $state<{ text: string; files?: unknown }[]>([{ text: 'first **ok** message' }]);
	counter = $state(0);
	tray = $state<PendingApproval[] | null>(null);
	approved: string[] = [];
	steps = $state<TurnStep[]>([]);
	chat = $state<ChatMessage[]>([]);

	push(text: string, files?: unknown) {
		this.messages.push({ text, files });
	}
	setTray(nonces: string[] | null) {
		this.tray = nonces && nonces.map((n) => pending(n));
	}
}

export const api = new Api();
