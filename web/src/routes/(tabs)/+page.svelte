<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { routedSheet } from '$lib/core/nav/sheet';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import { chatStore } from '$lib/features/chat';
	import {
		deepLinkItem,
		HomeScreen,
		needsYou,
		type HomeItem,
		type HomePeek
	} from '$lib/features/home';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	const home = needsYou();
	home.open();
	const sheet = routedSheet('peek');
	const DEEP_LINK_WAIT_MS = 5000;

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const unreachable = $derived(
		!pwa.online || hub.connection === 'forbidden' || hub.connection === 'closed'
	);
	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online) return { kind: 'app-offline' };
		if (hub.connection === 'forbidden') return 'forbidden';
		if (hub.connection === 'reconnecting') return { kind: 'reconnecting' };
		return undefined;
	});

	const greeted = $derived(home.live.greeted);
	const data = home.data;
	const remote = $derived({
		status:
			greeted || data.status === 'ready'
				? ('ready' as const)
				: data.status === 'error'
					? ('error' as const)
					: ('loading' as const),
		slow: data.slow,
		error: data.error
	});

	const items = $derived(Object.values(home.groups).flat());
	const peek = $derived.by((): HomePeek | undefined => {
		const id = sheet.arg;
		if (!sheet.open || !id) return undefined;
		const item = items.find((i) => i.id === id);
		const nonce = id.startsWith('approval:') ? id.slice('approval:'.length) : null;
		return {
			id,
			item,
			missing: item ? undefined : unreachable ? 'offline' : 'handled',
			submitting: nonce ? home.submitting.includes(nonce) : false,
			result: home.results[id]
		};
	});

	// A push opens /?approve=, /?ask= or /?item=; once Home knows what is waiting, the item opens
	// in its sheet, or the sheet says it was already handled. It never waits for good.
	onMount(() => {
		const target = deepLinkItem(page.url.searchParams);
		if (!target) return;
		let done = false;
		const open = () => {
			if (done) return;
			done = true;
			replaceState(resolve('/'), {});
			sheet.openWith(target);
		};
		const timer = setTimeout(open, DEEP_LINK_WAIT_MS);
		const stop = $effect.root(() => {
			$effect(() => {
				const settled = data.status === 'ready' || data.status === 'error';
				if ((greeted && settled) || unreachable) open();
			});
		});
		return () => {
			clearTimeout(timer);
			stop();
		};
	});

	// A navigation that replaced the sheet's shallow entry would leave back on a stale page, so the
	// sheet's entry is popped first and the new screen pushed after it.
	async function leaveTo(href: string) {
		if (sheet.open) {
			const popped = new Promise((r) => addEventListener('popstate', r, { once: true }));
			sheet.close();
			await popped;
			await tick();
		}
		await goto(href);
	}

	const openChat = () => void leaveTo(resolve('/chat'));

	function askAgent(item: HomeItem) {
		if (item.kind !== 'alert') return;
		const a = item.alert;
		const what = a.kind === 'stuck' ? 'is stuck' : 'failed';
		const quote = [`> Scheduled job ${a.job} ${what}`, ...(a.error ? [`> ${a.error}`] : [])];
		chatStore().setDraft(`${quote.join('\n')}\n\n`);
		openChat();
	}
</script>

<svelte:head><title>Home · Agent</title></svelte:head>

<HomeScreen
	groups={home.groups}
	{remote}
	partError={greeted && data.status === 'error' ? data.error : null}
	partLoading={greeted && data.status === 'loading' && data.slow}
	workspace={data.data?.workspace.state ?? 'online'}
	{connection}
	{now}
	{peek}
	updateReady={!!pwa.waiting}
	onopen={(id) => {
		home.clearResult(id);
		sheet.openWith(id);
	}}
	onclose={() => sheet.close()}
	onretry={() => void data.refetch()}
	ondecide={(nonce, d) => void home.decide(nonce, d)}
	onanswer={(askId, answer, index) => void home.answer(askId, answer, index)}
	ondismiss={(id) => {
		void home.dismiss(id);
		sheet.close();
	}}
	onopenrun={(id) => void leaveTo(resolve('/runs/[id]', { id }))}
	onopenchat={openChat}
	onaskagent={askAgent}
	onreload={() => pwa.applyUpdate()}
/>
