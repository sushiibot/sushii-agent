export interface AskQuestion {
	title: string;
	action?: { tool: string; command: string; why: string };
}

const WHY = "\n\nWhy it's asking: ";
const ACTION = /^([a-z][a-z0-9_-]*): ([\s\S]+)$/;

/** Splits a workspace confirm. The server appends the reason last, so the last marker is the real one;
 * the agent-written command may contain a forged one. */
export function splitAskQuestion(question: string): AskQuestion {
	const newline = question.indexOf('\n');
	const why = question.lastIndexOf(WHY);
	if (newline < 0 || why <= newline) return { title: question };
	const match = ACTION.exec(question.slice(newline + 1, why));
	if (!match) return { title: question };
	return {
		title: question.slice(0, newline),
		action: { tool: match[1]!, command: match[2]!, why: question.slice(why + WHY.length) }
	};
}
