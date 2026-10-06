export interface AskQuestion {
	title: string;
	action?: { tool: string; command: string; why: string };
}

const WHY = "\n\nWhy it's asking: ";
const ACTION = /^([a-z][a-z0-9_-]*): ([\s\S]+)$/;

/** Splits a workspace confirm. The server appends the reason last, so the last marker is the real one;
 * the agent-written command may contain a forged one. */
export function splitAskQuestion(question: string): AskQuestion {
	if (question.startsWith('Approve GitHub push\n')) {
		const command = question.slice('Approve GitHub push\n'.length);
		if (splitGitHubPush(command))
			return {
				title: 'GitHub push',
				action: {
					tool: 'github_push',
					command,
					why: 'This request covers the repository, branch and commit shown above.'
				}
			};
	}
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

/** Presentation only: never derives approval authority from text. */
export function splitGitHubPush(
	input: string
): { destination: string; commit: string; summary: string } | undefined {
	const match = /^([^\s/]+\/[^\s/]+ → [^\s]+)\n([a-f0-9]{40,64})\n([\s\S]+)$/.exec(input);
	return match ? { destination: match[1]!, commit: match[2]!, summary: match[3]! } : undefined;
}
