import type { ChatEventMap } from '$lib/core/realtime/events';
import type { PendingApproval } from '../types';

/** The tray's only input: the bot's durable `approval` event. There is deliberately no builder that
 *  takes message text, history JSONL or an ask, so no agent-written content can open the tray. */
export function pendingApproval(ev: ChatEventMap['approval']): PendingApproval {
	return {
		nonce: ev.nonce,
		view: {
			tool: ev.view.tool,
			agentId: ev.view.agentId,
			agentName: ev.view.agentName,
			fields: ev.view.fields.map((f) => ({ ...f }))
		}
	};
}
