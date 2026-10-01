// M5 flows: Memory, Skills and Schedules on their feature fixtures.
import {
	MemoryFileScreen,
	MemoryScreen,
	MemoryWriteScreen,
	MemoryWritesScreen
} from '$lib/features/memory';
import * as m from '$lib/features/memory/fixtures';
import { SkillScreen, SkillsScreen, SkillVersionsScreen } from '$lib/features/skills';
import * as sk from '$lib/features/skills/fixtures';
import { JobScreen, SchedulesScreen } from '$lib/features/schedules';
import * as sc from '$lib/features/schedules/fixtures';
import type { Flow, Frame } from './flows';

const NOW = new Date(2026, 8, 30, 16, 41).getTime();
const ready = { status: 'ready' } as const;
const slow = { status: 'loading', slow: true } as const;
const failed = { status: 'error', error: "The agent's server didn't answer." } as const;
const detail = (tab: string) => ({ shell: true, tab }) as const;
const back = (href: string) => ({ href, label: 'Back' });

const files = m.memoryFiles(NOW);
const writes = m.memoryWrites(NOW);
const overview = { files, writes };
const write = (id: string) => writes.find((w) => w.id === id)!;
const memory = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	data: overview,
	now: NOW,
	back: back('/more'),
	...props
});
const change = (id: string, props: Record<string, unknown> = {}) => ({
	remote: ready,
	write: write(id),
	now: NOW,
	back: back('/memory'),
	...props
});
const file = (id: string) => ({
	remote: ready,
	detail: { file: files.find((f) => f.id === id)!, writes: writes.filter((w) => w.fileId === id) },
	now: NOW,
	back: back('/memory')
});

const memoryFrames: Frame[] = [
	{
		id: 'ms-1',
		label: 'Memory: recent changes, then files',
		screen: MemoryScreen,
		props: memory(),
		...detail('memory'),
		next: 'Open a change',
		hits: { 'added: eastside': 'ms-2', 'all 6 changes': 'ms-5' }
	},
	{
		id: 'ms-2',
		label: 'A change from a run that read outside content',
		screen: MemoryWriteScreen,
		props: change(m.WRITES.vendor),
		...detail('memory'),
		next: 'Revert',
		hits: { 'revert this change': 'ms-3', 'memory.md': 'ms-4' }
	},
	{
		id: 'ms-3',
		label: 'Reverted, with Restore',
		screen: MemoryWriteScreen,
		props: change(m.WRITES.vendor, {
			write: {
				...write(m.WRITES.vendor),
				reverted: { at: new Date(NOW).toISOString(), commit: '9d1e3aa' }
			},
			result: {
				kind: 'reverted',
				text: 'Change reverted. The agent stops seeing it from its next turn.'
			}
		}),
		...detail('memory'),
		hits: { restore: 'ms-2' }
	},
	{
		id: 'ms-4',
		label: 'A memory file, as the agent wrote it',
		screen: MemoryFileScreen,
		props: file('memory-md'),
		...detail('memory'),
		branch: 'Tap the file name'
	},
	{
		id: 'ms-5',
		label: 'Every change, by day',
		screen: MemoryWritesScreen,
		props: { remote: ready, writes, now: NOW, back: back('/memory') },
		...detail('memory'),
		branch: 'All changes'
	},
	{
		id: 'ms-6',
		label: 'From a thread',
		screen: MemoryWriteScreen,
		props: change(m.WRITES.thursday),
		...detail('memory'),
		branch: 'A change that removed a line'
	},
	{
		id: 'ms-7',
		label: 'Nothing remembered yet',
		screen: MemoryScreen,
		props: memory({ data: { files: [], writes: [] } }),
		...detail('memory'),
		branch: 'Empty'
	},
	{
		id: 'ms-8',
		label: 'Loading, slowly',
		screen: MemoryScreen,
		props: memory({ remote: slow, data: undefined }),
		...detail('memory'),
		branch: 'Slow network'
	},
	{
		id: 'ms-9',
		label: "Couldn't load",
		screen: MemoryScreen,
		props: memory({ remote: failed, data: undefined }),
		...detail('memory'),
		branch: 'The server fails'
	},
	{
		id: 'ms-10',
		label: 'Offline: Revert waits for the agent',
		screen: MemoryWriteScreen,
		props: change(m.WRITES.seat, { online: false }),
		...detail('memory'),
		branch: 'Phone offline'
	},
	{
		id: 'ms-d',
		label: 'Desktop: a change',
		screen: MemoryWriteScreen,
		props: change(m.WRITES.vendor),
		...detail('memory'),
		desktop: true
	}
];

const skills = sk.skillDetails(NOW);
const skill = (name: string, props: Record<string, unknown> = {}) => ({
	remote: ready,
	skill: skills.find((s) => s.name === name),
	now: NOW,
	back: back('/skills'),
	...props
});
const skillList = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	skills: sk.skillSummaries(NOW),
	now: NOW,
	back: back('/more'),
	...props
});

const skillFrames: Frame[] = [
	{
		id: 'sk-1',
		label: 'Skills by stage',
		screen: SkillsScreen,
		props: skillList(),
		...detail('skills'),
		next: 'Open a skill',
		hits: { 'deploy-relay-bot': 'sk-2', 'rent-receipts': 'sk-4' }
	},
	{
		id: 'sk-2',
		label: 'A skill in use',
		screen: SkillScreen,
		props: skill('deploy-relay-bot'),
		...detail('skills'),
		next: 'Versions',
		hits: { versions: 'sk-3' }
	},
	{
		id: 'sk-3',
		label: 'SKILL.md and its versions, with diffs',
		screen: SkillVersionsScreen,
		props: skill('deploy-relay-bot', { back: back('/skills/deploy-relay-bot') }),
		...detail('skills')
	},
	{
		id: 'sk-4',
		label: 'A draft: Use it now, or Archive',
		screen: SkillScreen,
		props: skill('rent-receipts'),
		...detail('skills'),
		branch: 'A skill still in draft'
	},
	{
		id: 'sk-5',
		label: 'Stale',
		screen: SkillScreen,
		props: skill('flight-checkin'),
		...detail('skills'),
		branch: 'Unused for 90 days'
	},
	{
		id: 'sk-6',
		label: 'No skills yet',
		screen: SkillsScreen,
		props: skillList({ skills: [] }),
		...detail('skills'),
		branch: 'Empty'
	},
	{
		id: 'sk-7',
		label: "Couldn't load",
		screen: SkillsScreen,
		props: skillList({ remote: failed, skills: [] }),
		...detail('skills'),
		branch: 'The server fails'
	},
	{
		id: 'sk-8',
		label: 'Loading, slowly',
		screen: SkillScreen,
		props: skill('deploy-relay-bot', { remote: slow, skill: undefined }),
		...detail('skills'),
		branch: 'Slow network'
	}
];

const jobs = sc.jobDetails(NOW);
const job = (id: string, props: Record<string, unknown> = {}) => ({
	remote: ready,
	job: jobs.find((j) => j.id === id),
	now: NOW,
	back: back('/schedules'),
	...props
});
const jobList = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	jobs,
	now: NOW,
	back: back('/more'),
	...props
});

const scheduleFrames: Frame[] = [
	{
		id: 'sc-1',
		label: 'Schedules: a failed job leads',
		screen: SchedulesScreen,
		props: jobList(),
		...detail('schedules'),
		next: 'Open the failed job',
		hits: { 'back up projects': 'sc-2', 'inbox watch': 'sc-5' }
	},
	{
		id: 'sc-2',
		label: 'Job: next run, history, test run',
		screen: JobScreen,
		props: job('nightly-sync'),
		...detail('schedules'),
		next: 'Test run',
		hits: { 'test run': 'sc-3' }
	},
	{
		id: 'sc-3',
		label: 'Test running, sending off',
		screen: JobScreen,
		props: job('nightly-sync', { test: { state: 'running', step: 'Running step 2 of about 4' } }),
		...detail('schedules'),
		next: 'Finishes'
	},
	{
		id: 'sc-4',
		label: 'Test result',
		screen: JobScreen,
		props: job('nightly-sync', {
			test: {
				state: 'done',
				result: 'failed',
				note: 'Still can’t reach the backup server. Nothing was sent.'
			}
		}),
		...detail('schedules'),
		hits: { 'test again': 'sc-3' }
	},
	{
		id: 'sc-5',
		label: 'A quiet job says why it was quiet',
		screen: JobScreen,
		props: job('inbox-triage'),
		...detail('schedules'),
		branch: 'Nothing new, suppressed, outside hours'
	},
	{
		id: 'sc-6',
		label: 'Paused',
		screen: JobScreen,
		props: job('repo-backup-check'),
		...detail('schedules'),
		branch: 'A job you paused'
	},
	{
		id: 'sc-7',
		label: 'No jobs yet',
		screen: SchedulesScreen,
		props: jobList({ jobs: [] }),
		...detail('schedules'),
		branch: 'Empty'
	},
	{
		id: 'sc-8',
		label: 'Loading, slowly',
		screen: SchedulesScreen,
		props: jobList({ remote: slow, jobs: [] }),
		...detail('schedules'),
		branch: 'Slow network'
	},
	{
		id: 'sc-9',
		label: 'Offline',
		screen: JobScreen,
		props: job('briefing', { online: false }),
		...detail('schedules'),
		branch: 'Phone offline: no test run'
	}
];

export const m5Flows: Flow[] = [
	{
		id: 'memory',
		code: 'MS',
		title: 'Memory',
		intro:
			'What the agent remembers, as files, and every change to them as a diff with the run or thread that wrote it and whether that run had read outside content. Revert is one tap, with Restore in the toast.',
		frames: memoryFrames
	},
	{
		id: 'skills',
		code: 'SK',
		title: 'Skills',
		intro:
			'How-tos the agent wrote for itself, by stage, with why each is there, the runs that loaded it, and every version as a diff. A draft loads on its own only after three verified runs.',
		frames: skillFrames
	},
	{
		id: 'schedules',
		code: 'SC',
		title: 'Schedules',
		intro:
			'Each job shows its next run and says why its last run was quiet: nothing new, suppressed, skipped, outside hours or failed. Test-run a job, with sending off, before trusting it.',
		frames: scheduleFrames
	}
];

export const m5Routes: [string, string][] = [
	[`/memory/writes/${m.WRITES.vendor}`, 'ms-2'],
	[`/memory/writes/${m.WRITES.thursday}`, 'ms-6'],
	['/memory/writes/*', 'ms-2'],
	['/memory/writes', 'ms-5'],
	['/memory/files/*', 'ms-4'],
	['/memory', 'ms-1'],
	['/skills/deploy-relay-bot/versions', 'sk-3'],
	['/skills/deploy-relay-bot', 'sk-2'],
	['/skills/rent-receipts', 'sk-4'],
	['/skills/*', 'sk-5'],
	['/skills', 'sk-1'],
	['/schedules/nightly-sync', 'sc-2'],
	['/schedules/repo-backup-check', 'sc-6'],
	['/schedules/*', 'sc-5'],
	['/schedules', 'sc-1']
];
