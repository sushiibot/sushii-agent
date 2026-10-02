import type { AskView, ApprovalOutcome } from './types';
/** Same accepted yes/no words as the workspace confirm parser; a closed unanswered ask is cancelled. */
export function confirmationOutcome(ask: Pick<AskView, 'answer' | 'state'>): ApprovalOutcome {
	const answer = ask.answer?.trim() ?? '';
	if (/^(y|yes|ok|okay|approve|allow|confirm|sure)$/i.test(answer))
		return ask.state === 'elsewhere' ? 'approved-elsewhere' : 'approved';
	if (/^(n|no|deny|reject|cancel|decline)$/i.test(answer))
		return ask.state === 'elsewhere' ? 'denied-elsewhere' : 'denied';
	return ask.state === 'pending' || ask.state === 'answering' ? 'pending' : 'cancelled';
}
