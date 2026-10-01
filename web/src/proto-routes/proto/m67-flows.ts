// M6 and M7 flows: the browser takeover placeholder, the briefing and connectors, on fixtures.
import { BrowserScreen } from '$lib/features/browser';
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

export const m67Flows: Flow[] = [
	{
		id: 'browser',
		code: 'BT',
		title: 'Take over the browser',
		intro:
			'A placeholder for the state flow only: the agent drives, you take over and it is locked out, you hand back. The real address always shows. The live view and the field sheet come with the browser container.',
		frames: browserFrames
	}
];

export const m67Routes: [string, string][] = [['/browser', 'bt-1']];
