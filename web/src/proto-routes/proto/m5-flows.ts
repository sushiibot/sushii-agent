// M5 flows: Memory, Skills and Schedules on their feature fixtures.
import {
	MemoryFileScreen,
	MemoryScreen,
	MemoryWriteScreen,
	MemoryWritesScreen
} from '$lib/features/memory';
import * as m from '$lib/features/memory/fixtures';
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

export const m5Flows: Flow[] = [
	{
		id: 'memory',
		code: 'MS',
		title: 'Memory',
		intro:
			'What the agent remembers, as files, and every change to them as a diff with the run or thread that wrote it and whether that run had read outside content. Revert is one tap, with Restore in the toast.',
		frames: memoryFrames
	}
];

export const m5Routes: [string, string][] = [
	[`/memory/writes/${m.WRITES.vendor}`, 'ms-2'],
	[`/memory/writes/${m.WRITES.thursday}`, 'ms-6'],
	['/memory/writes/*', 'ms-2'],
	['/memory/writes', 'ms-5'],
	['/memory/files/*', 'ms-4'],
	['/memory', 'ms-1']
];
