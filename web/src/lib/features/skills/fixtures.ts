// Typed fixtures for Skills, shared by the fake API, the prototype board and tests. Made up.
import type { SkillDetail, SkillSummary } from './types';

const DAY = 86_400_000;
const iso = (now: number, daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
const RUN = {
	refactor: '01K6AZT2V4X6Z8B0D2F4H6K8M0',
	weeklyDeps: '01K6AZ8B0D2F4H6K8M0P2R4T6V',
	invoice: '01K6B4A0C2E4G6J8M0P2R4T6V8'
};

export function skillDetails(now: number): SkillDetail[] {
	return [
		{
			name: 'deploy-relay-bot',
			description: 'Blue/green switch for relay-bot production, with an error-rate watch.',
			stage: 'active',
			uses: 23,
			successRate: 0.96,
			lastUsed: iso(now, 1),
			version: 3,
			why: 'Promoted after 5 runs in a row that ended with a verified health check.',
			history: [
				{ at: iso(now, 2), event: 'Updated', reason: 'You corrected the drain delay in chat.' },
				{ at: iso(now, 18), event: 'Promoted to active', reason: '5 verified runs in a row.' },
				{ at: iso(now, 31), event: 'Drafted', reason: 'Learned from a deploy you walked through.' }
			],
			runs: [
				{ id: RUN.refactor, title: 'relay-bot 4.18.2', ok: true, at: iso(now, 1) },
				{ id: RUN.weeklyDeps, title: 'relay-bot 4.17.0', ok: false, at: iso(now, 9) }
			],
			content: [
				'## Steps',
				'1. Build and push the green image.',
				'2. Start green next to blue.',
				'3. Check `/healthz` on green.',
				'4. Switch traffic to green.',
				'5. Watch the error rate for 30 minutes, then drain blue.'
			].join('\n'),
			versions: [
				{
					version: 3,
					at: iso(now, 2),
					reason: 'You said 10 minutes was too short to see a slow leak.',
					run: { id: RUN.refactor, title: 'relay-bot 4.18.2' },
					diff: [
						{ kind: 'ctx', text: '4. Switch traffic to green.' },
						{ kind: 'del', text: '5. Drain blue after 10 minutes.' },
						{ kind: 'add', text: '5. Watch the error rate for 30 minutes, then drain blue.' }
					]
				},
				{
					version: 2,
					at: iso(now, 18),
					reason: 'Added a health check before the switch.',
					diff: [
						{ kind: 'ctx', text: '2. Start green next to blue.' },
						{ kind: 'add', text: '3. Check `/healthz` on green.' }
					]
				},
				{
					version: 1,
					at: iso(now, 31),
					reason: 'First draft, from a deploy you walked through.',
					diff: [
						{ kind: 'add', text: '## Steps' },
						{ kind: 'add', text: '1. Build and push the green image.' },
						{ kind: 'add', text: '2. Start green next to blue.' },
						{ kind: 'add', text: '4. Switch traffic to green.' },
						{ kind: 'add', text: '5. Drain blue after 10 minutes.' }
					]
				}
			]
		},
		{
			name: 'rent-receipts',
			description: 'File the monthly rent receipt and match it to the bank entry.',
			stage: 'draft',
			uses: 2,
			successRate: 1,
			lastUsed: iso(now, 0.2),
			version: 1,
			why: 'Held as a draft: it needs 3 verified runs before it loads on its own.',
			history: [
				{ at: iso(now, 29), event: 'Drafted', reason: 'Written after a filing you did by hand.' }
			],
			runs: [{ id: RUN.invoice, title: 'October rent', ok: true, at: iso(now, 0.2) }],
			content:
				'## Steps\n1. Find the receipt email.\n2. Save the PDF to `finance/rent/`.\n3. Match it to the bank entry.',
			versions: [
				{
					version: 1,
					at: iso(now, 29),
					reason: 'First draft.',
					diff: [
						{ kind: 'add', text: '1. Find the receipt email.' },
						{ kind: 'add', text: '2. Save the PDF to `finance/rent/`.' },
						{ kind: 'add', text: '3. Match it to the bank entry.' }
					]
				}
			]
		},
		{
			name: 'flight-checkin',
			description: 'Check in 24 hours before departure and save the boarding pass.',
			stage: 'stale',
			uses: 4,
			successRate: 0.75,
			lastUsed: iso(now, 119),
			version: 2,
			why: 'Marked stale: unused for 90 days, and the airline site changed since.',
			history: [
				{ at: iso(now, 29), event: 'Marked stale', reason: 'No use in 90 days.' },
				{ at: iso(now, 181), event: 'Promoted to active', reason: '3 verified runs.' }
			],
			runs: [],
			content: '## Steps\n1. Open the airline check-in page.\n2. Pick the saved seat preference.',
			versions: [
				{
					version: 2,
					at: iso(now, 181),
					reason: 'Seat preference moved to USER.md.',
					diff: [
						{ kind: 'del', text: '2. Pick an aisle seat.' },
						{ kind: 'add', text: '2. Pick the saved seat preference.' }
					]
				}
			]
		},
		{
			name: 'mod-digest',
			description: 'Summarize moderation cases each morning.',
			stage: 'archived',
			uses: 41,
			successRate: 0.9,
			lastUsed: iso(now, 78),
			version: 4,
			why: 'Archived when you deleted its morning schedule.',
			history: [{ at: iso(now, 78), event: 'Archived', reason: 'Its schedule was deleted.' }],
			runs: [],
			content: '## Steps\n1. Collect new cases.\n2. Summarize by server.',
			versions: []
		}
	];
}

export function skillSummaries(now: number): SkillSummary[] {
	return skillDetails(now).map(
		({ name, description, stage, uses, successRate, lastUsed, version }) => ({
			name,
			description,
			stage,
			uses,
			successRate,
			lastUsed,
			version
		})
	);
}
