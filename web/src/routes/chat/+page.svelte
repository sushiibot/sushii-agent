<script lang="ts">
	import { BackgroundAgents } from '$lib/features/runs';
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { features } from '$lib/core/features.svelte';
	import { leaveSheet, routedSheet } from '$lib/core/nav/sheet';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import {
		ChatScreen,
		ClearNotifications,
		chatStore,
		modelsStore,
		Dictation,
		type ChatSheet,
		type ChatMessage,
		type FileRef
	} from '$lib/features/chat';
	import { BranchSheet, threadsStore } from '$lib/features/threads';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	const store = chatStore();
	const threadsOn = $derived(features.has('threads'));
	const threads = $derived(threadsOn ? threadsStore() : null);
	const branch = routedSheet('branch');
	let branchFrom = $state<{ id: string; quote: string } | null>(null);
	let threadTitle = $state('');
	const s = store;
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());

	const sheets: Record<ChatSheet, ReturnType<typeof routedSheet>> = {
		commands: routedSheet('commands'),
		new: routedSheet('new'),
		viewer: routedSheet('viewer'),
		model: routedSheet('model')
	};
	const models = modelsStore();
	let modelRole = $state<'main' | 'fallback'>('main');
	// The transcript joins whatever is already in the box, like keyboard dictation. Kept on screen while
	// it runs, so a feature flip can't hide the stop control of a recording in progress.
	const dictation = new Dictation((text) => {
		const draft = store.draft.trimEnd();
		store.setDraft(draft ? `${draft} ${text}` : text);
	});
	const sheet = $derived((Object.keys(sheets) as ChatSheet[]).find((s) => sheets[s].open));
	const focusAsk = $derived(page.url.searchParams.get('ask') ?? undefined);

	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online) return { kind: 'offline' };
		if (hub.connection === 'forbidden') return 'forbidden';
		if (hub.connection === 'reconnecting' && hub.reconnectingSince !== null) {
			const secs = Math.floor((now - hub.reconnectingSince) / 1000);
			return { kind: 'reconnecting', elapsed: secs >= 5 ? `${secs}s` : undefined };
		}
		if (store.workspace === 'offline') return { kind: 'agent-offline' };
		if (store.reset) return { kind: 'reset' };
		return undefined;
	});

	$effect(() => {
		if (hub.connection !== 'reconnecting') return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	onMount(() => {
		void models.remote.ensure();
		const unwatch = models.remote.watch();
		return () => {
			unwatch();
			dictation.cancel();
		};
	});

	// `!model`, another device or a workspace restart can change the model: reload whenever the agent
	// comes (back) online, which also covers the first load.
	$effect(() => {
		if (s.workspace === 'online') untrack(() => models.refresh());
	});

	$effect(() => {
		untrack(() => store.setViewing(true));
		return () => store.setViewing(false);
	});

	// A push for a question opens /?ask=<id>; its card scrolls into view once history has it.
	$effect(() => {
		const askId = untrack(() => focusAsk);
		if (!askId) return;
		let done = false;
		return $effect.root(() => {
			$effect(() => {
				const item = store.items.find((i) => i.kind === 'ask' && i.askId === askId);
				if (!item || done) return;
				done = true;
				void tick().then(() =>
					document
						.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)
						?.scrollIntoView({ block: 'center' })
				);
			});
		});
	});

	function openSheet(next: ChatSheet) {
		if (next === 'model') {
			models.refresh();
			modelRole = 'main';
		}
		sheets[next].openWith();
	}

	function closeSheet() {
		if (sheet) sheets[sheet].close();
	}

	const plain = (m: ChatMessage) =>
		m.parts
			.flatMap((p) => (p.type === 'text' ? [p.text] : []))
			.join(' ')
			.slice(0, 280);

	function openBranch(m: ChatMessage) {
		branchFrom = { id: m.sourceId ?? m.id, quote: plain(m) };
		threadTitle = '';
		threads?.clearError();
		branch.openWith();
	}

	async function startThread(name: string) {
		const id = await threads?.branch(branchFrom?.id ?? '', name);
		if (!id) return;
		await leaveSheet(branch);
		await goto(resolve('/chats/[id]', { id }));
	}
</script>

<svelte:head><title>Main · sushii</title></svelte:head>

{#snippet backgroundActivity()}<BackgroundAgents
		onrun={(id) => goto(resolve('/runs/[id]', { id }))}
		compact
	/>{/snippet}
{#snippet delegatedActivity(turnId: string)}<BackgroundAgents
		onrun={(id) => goto(resolve('/runs/[id]', { id }))}
		{turnId}
	/>{/snippet}

<ChatScreen
	title="Main"
	{backgroundActivity}
	{delegatedActivity}
	approvalSubmitting={s.trayPhase === 'submitting'}
	messages={s.messages}
	history={s.history}
	hasOlder={s.hasOlder}
	olderLoading={s.olderLoading}
	olderError={s.olderError}
	running={s.running}
	stopping={s.stopping}
	approvals={store.approvals}
	draft={s.draft}
	photos={s.photos}
	quotaFull={s.quotaFull}
	usage={s.usage}
	models={models.remote.data ?? null}
	modelPicking={models.picking}
	modelError={models.error}
	{modelRole}
	modelQuery={models.query}
	modelResults={models.results}
	modelSearching={models.searching}
	modelSearchError={models.searchError}
	onmodelrole={(r) => (modelRole = r)}
	onmodelquery={(q) => models.setQuery(q)}
	dictation={features.dictation || dictation.state !== 'idle'
		? { state: dictation.state, seconds: dictation.seconds, error: dictation.error }
		: null}
	ondictate={() => dictation.toggle()}
	onpickmodel={(alias, role) => void models.pick(alias, role).then((ok) => ok && closeSheet())}
	{connection}
	commandsOffline={s.workspace === 'offline'}
	toast={s.toast}
	updateReady={!!pwa.waiting}
	canInstall={pwa.canInstall}
	announce={s.announce}
	{focusAsk}
	{sheet}
	{viewer}
	subtitle={threadsOn ? mainSubtitle : undefined}
	onbranch={threadsOn ? openBranch : undefined}
	onopensheet={openSheet}
	onclosesheet={closeSheet}
	onopenfile={(f) => {
		viewer = f;
		openSheet('viewer');
	}}
	ondraft={(v) => s.setDraft(v)}
	onsend={() => void s.send(s.draft)}
	onstop={() => s.stopTurn()}
	oncommand={(c) => s.command(c)}
	onattach={(files) => void s.attach(files)}
	onremovephoto={(id) => s.removePhoto(id)}
	onretryphoto={(id) => s.retryPhoto(id)}
	onloadolder={() => s.loadOlder()}
	onretryhistory={() => s.retryHistory()}
	onretrysend={(id) => s.retry(id)}
	onsteersend={(id) => s.steerNow(id)}
	ondeletesend={(id) => void s.discard(id)}
	onanswer={(askId, answer) => s.answer(askId, answer)}
	onapprove={(nonce, location) => void s.decide(nonce, 'approve', location)}
	ondeny={(nonce) => void s.decide(nonce, 'deny')}
	oninstall={() => pwa.install()}
	onreload={() => pwa.applyUpdate()}
/>
<ClearNotifications store={s} />

{#snippet mainSubtitle()}
	<span class="text-xs text-muted-foreground">
		{#if s.running}The agent is working{:else}General conversation · context from threads when
			useful{/if}
	</span>
{/snippet}

{#if threads}
	<BranchSheet
		open={branch.open}
		quote={branchFrom?.quote}
		bind:title={threadTitle}
		busy={threads.busy}
		error={threads.error}
		onstart={(name) => void startThread(name)}
		onclose={() => branch.close()}
	/>
{/if}
