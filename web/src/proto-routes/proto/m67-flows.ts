// M6 and M7 flows: the browser takeover placeholder, the briefing and connectors, on fixtures.
import { BrowserScreen } from '$lib/features/browser';
import { BriefingScreen } from '$lib/features/briefing';
import * as br from '$lib/features/briefing/fixtures';
import { AddServerScreen, ConnectorsScreen, McpServerScreen } from '$lib/features/connectors';
import * as cn from '$lib/features/connectors/fixtures';
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

const servers = cn.servers(NOW);
const summaries = servers.map(({ snapshotAt, toolList, history, usedBy, ...s }) => s);
const server = (id: string, props: Record<string, unknown> = {}) => ({
	remote: ready,
	server: servers.find((s) => s.id === id),
	now: NOW,
	back: back('/connectors'),
	...props
});
const add = (a: Record<string, unknown>) => ({
	add: { stage: 'url', url: '', redirect: '', busy: false, error: null, ...a },
	back: back('/connectors')
});
const authUrl =
	'https://mcp.tracker.example/oauth/authorize?client_id=agent&redirect_uri=http%3A%2F%2Flocalhost%3A7461%2Fcallback&state=q8Zt2';

const connectorFrames: Frame[] = [
	{
		id: 'mc-1',
		label: 'Connectors',
		screen: ConnectorsScreen,
		props: { remote: ready, servers: summaries, back: back('/more') },
		...detail('connectors'),
		next: 'Add a server',
		hits: { 'add a server': 'mc-2', 'code host': 'mc-6', calendar: 'mc-7' }
	},
	{
		id: 'mc-2',
		label: 'Paste the address',
		screen: AddServerScreen,
		props: add({ url: 'https://mcp.tracker.example/sse' }),
		...detail('connectors'),
		next: 'Continue',
		hits: { continue: 'mc-3' }
	},
	{
		id: 'mc-3',
		label: 'Sign in on any device',
		screen: AddServerScreen,
		props: add({
			stage: 'oauth',
			url: 'https://mcp.tracker.example/sse',
			name: 'Tracker',
			authUrl
		}),
		...detail('connectors'),
		next: 'Signed in',
		hits: { "i've signed in": 'mc-4' }
	},
	{
		id: 'mc-4',
		label: 'Paste the address the browser landed on',
		screen: AddServerScreen,
		props: add({
			stage: 'paste',
			url: 'https://mcp.tracker.example/sse',
			name: 'Tracker',
			redirect: 'http://localhost:7461/callback?code=trk_8f2Kq0x&state=q8Zt2'
		}),
		...detail('connectors'),
		next: 'Connect',
		hits: { connect: 'mc-5' }
	},
	{
		id: 'mc-5',
		label: 'Connected, with its tools saved',
		screen: McpServerScreen,
		props: {
			remote: ready,
			server: cn.newServer(NOW, 'https://mcp.tracker.example/sse', 'Tracker'),
			now: NOW,
			back: back('/connectors'),
			justConnected: true
		},
		...detail('connectors')
	},
	{
		id: 'mc-6',
		label: 'The server changed its tools',
		screen: McpServerScreen,
		props: server('code-host'),
		...detail('connectors'),
		branch: 'A tool added, one removed since the saved list'
	},
	{
		id: 'mc-7',
		label: 'Sign-in expired',
		screen: McpServerScreen,
		props: server('calendar'),
		...detail('connectors'),
		branch: 'Needs you to sign in again'
	},
	{
		id: 'mc-8',
		label: 'A redirect with no code',
		screen: AddServerScreen,
		props: add({
			stage: 'paste',
			url: 'https://mcp.tracker.example/sse',
			name: 'Tracker',
			redirect: 'http://localhost:7461/callback?error=access_denied'
		}),
		...detail('connectors'),
		branch: 'Pasted the wrong address'
	},
	{
		id: 'mc-9',
		label: 'No servers yet',
		screen: ConnectorsScreen,
		props: { remote: ready, servers: [], back: back('/more') },
		...detail('connectors'),
		branch: 'Empty'
	},
	{
		id: 'mc-10',
		label: "Couldn't load",
		screen: ConnectorsScreen,
		props: {
			remote: { status: 'error', error: "The agent's server didn't answer." },
			servers: [],
			back: back('/more')
		},
		...detail('connectors'),
		branch: 'The server fails'
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
	},
	{
		id: 'connectors',
		code: 'MC',
		title: 'Connectors: MCP servers',
		intro:
			'Each server with its saved tool list and history, and the runs that used it. A changed tool list waits for you to accept it. Adding by URL: the agent runs on a server, so sign-in ends on a localhost page that fails to load, and you paste that address back.',
		frames: connectorFrames
	}
];

export const m67Routes: [string, string][] = [
	['/browser', 'bt-1'],
	['/briefing', 'br-1'],
	['/connectors/add', 'mc-2'],
	['/connectors/code-host', 'mc-6'],
	['/connectors/calendar', 'mc-7'],
	['/connectors/*', 'mc-6'],
	['/connectors', 'mc-1']
];
