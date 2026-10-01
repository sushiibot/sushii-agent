// M6 and M7 flows: the browser takeover placeholder, the briefing and connectors, on fixtures.
import { BrowserScreen } from '$lib/features/browser';
import { BriefingScreen } from '$lib/features/briefing';
import * as br from '$lib/features/briefing/fixtures';
import type { Flow, Frame } from './flows';

const NOW = new Date(2026, 8, 30, 16, 41).getTime();
const ready = { status: 'ready' } as const;
const detail = (tab: string) => ({ shell: true, tab }) as const;
const back = (href: string) => ({ href, label: 'Back' });

const browserStatus = (holder: 'idle' | 'agent' | 'you') =>
	holder === 'idle'
		? { holder }
		: {
				holder,
				url: 'https://accounts.example.com/signin?continue=%2Fbilling',
				since: new Date(NOW - 2 * 60_000).toISOString(),
				task: { runId: '01K6B4D2F4H6K8M0P2R4T6V8X0', title: 'Download the September invoice' }
			};
const browser = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	status: browserStatus('agent'),
	now: NOW,
	back: back('/more'),
	...props
});

const browserFrames: Frame[] = [
	{
		id: 'bt-1',
		label: 'The agent is on a sign-in page',
		screen: BrowserScreen,
		props: browser(),
		...detail('browser'),
		next: 'Take over',
		hits: { 'take over': 'bt-2' }
	},
	{
		id: 'bt-2',
		label: 'Waiting for the agent to let go',
		screen: BrowserScreen,
		props: browser({ pending: 'taking' }),
		...detail('browser'),
		next: 'Lock granted'
	},
	{
		id: 'bt-3',
		label: 'You drive; the agent is locked out',
		screen: BrowserScreen,
		props: browser({ status: browserStatus('you') }),
		...detail('browser'),
		next: 'Hand back',
		hits: { 'hand back': 'bt-4' }
	},
	{
		id: 'bt-4',
		label: 'Handing back',
		screen: BrowserScreen,
		props: browser({ status: browserStatus('you'), pending: 'handing' }),
		...detail('browser'),
		hits: {}
	},
	{
		id: 'bt-5',
		label: 'Nobody is using it',
		screen: BrowserScreen,
		props: browser({ status: browserStatus('idle') }),
		...detail('browser'),
		branch: 'Idle'
	},
	{
		id: 'bt-6',
		label: "Couldn't reach the browser",
		screen: BrowserScreen,
		props: browser({
			remote: { status: 'error', error: "The agent's server didn't answer." },
			status: undefined
		}),
		...detail('browser'),
		branch: 'The server fails'
	},
	{
		id: 'bt-7',
		label: 'Offline: no takeover',
		screen: BrowserScreen,
		props: browser({ online: false }),
		...detail('browser'),
		branch: 'Phone offline'
	}
];

const brief = br.briefing(NOW);
const rated = {
	...brief,
	items: brief.items.map((i) =>
		i.id === 'b-review'
			? { ...i, vote: 'up' as const }
			: i.id === 'b-backup'
				? { ...i, vote: 'up' as const }
				: i.id === 'b-flight'
					? { ...i, vote: 'down' as const }
					: i.id === 'b-lease'
						? { ...i, dismissed: true }
						: i
	)
};
const briefingProps = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	briefing: brief,
	now: NOW,
	back: back('/more'),
	...props
});

const briefingFrames: Frame[] = [
	{
		id: 'br-1',
		label: 'Briefing: items with sources',
		screen: BriefingScreen,
		props: briefingProps(),
		...detail('briefing'),
		next: 'Rate and dismiss'
	},
	{
		id: 'br-2',
		label: 'After feedback',
		screen: BriefingScreen,
		props: briefingProps({ briefing: rated }),
		...detail('briefing'),
		scrollTo: 300
	},
	{
		id: 'br-3',
		label: 'No briefing yet',
		screen: BriefingScreen,
		props: briefingProps({ briefing: null }),
		...detail('briefing'),
		branch: 'Before the first morning'
	},
	{
		id: 'br-4',
		label: "A vote that didn't save",
		screen: BriefingScreen,
		props: briefingProps({
			error: "Couldn't save that. Check your connection and try again.",
			online: false
		}),
		...detail('briefing'),
		branch: 'Phone offline'
	},
	{
		id: 'br-5',
		label: 'Loading, slowly',
		screen: BriefingScreen,
		props: briefingProps({ remote: { status: 'loading', slow: true }, briefing: undefined }),
		...detail('briefing'),
		branch: 'Slow network'
	}
];

export const m67Flows: Flow[] = [
	{
		id: 'browser',
		code: 'BT',
		title: 'Take over the browser',
		intro:
			'A placeholder for the state flow only: the agent drives, you take over and it is locked out, you hand back. The real address always shows. The live view and the field sheet come with the browser container.',
		frames: browserFrames
	},
	{
		id: 'brief',
		code: 'BR',
		title: 'Morning briefing',
		intro:
			'Each item has its source, Useful and Not useful buttons that tune tomorrow’s ranking, and Dismiss with Undo. All are plain buttons; nothing hides behind a gesture.',
		frames: briefingFrames
	}
];

export const m67Routes: [string, string][] = [
	['/browser', 'bt-1'],
	['/briefing', 'br-1']
];
