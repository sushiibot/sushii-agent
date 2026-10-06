<script lang="ts">
	import { BrowserPreview, BrowserPreviewPanel } from '$lib/features/browser';
	import { BackgroundAgents } from '$lib/features/runs';
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { leaveSheet, routedSheet } from '$lib/core/nav/sheet';
	import { offlineBrowsing } from '$lib/core/storage/offline.svelte';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import {
		ChatScreen,
		ClearNotifications,
		chatStore,
		modelsStore,
		Dictation,
		VoiceControl,
		Voice,
		VoiceCallBar,
		VoiceCaptions,
		type ChatSheet,
		type ChatMessage,
		type FileRef
	} from '$lib/features/chat';
	import { BranchSheet, threadsStore } from '$lib/features/threads';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	const store = chatStore();
	const threads = threadsStore();
	const branch = routedSheet('branch');
	const browserSheet = routedSheet('browser-preview');
	const browser = new BrowserPreview('main');
	$effect(() => {
		const preview = browser;
		return untrack(() => preview.start());
	});
	$effect(() => {
		const preview = browser;
		const expanded = browserSheet.open;
		untrack(() => preview.setExpanded(expanded));
	});
	const voiceSheet = routedSheet('voice');
	const voice = new Voice();
	let voiceActive = $state(false);
	let branchFrom = $state<{ id: string; quote: string } | null>(null);
	let threadTitle = $state('');
	const s = store;
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());

	const sheets: Record<ChatSheet, ReturnType<typeof routedSheet>> = {
		commands: routedSheet('commands'),
		new: routedSheet('new'),
		viewer: routedSheet('viewer'),
		model: routedSheet('model'),
		context: routedSheet('context'),
		'context-boundary': routedSheet('context-boundary')
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
	$effect(() => {
		if (sheet !== 'model' && sheet !== 'context') return;
		untrack(() => models.refresh());
	});

	const contextRevision = $derived(
		`${s?.running}:${JSON.stringify(s?.usage)}:${s?.items.findLast((i) => i.kind === 'divider')?.id}:${s?.items.findLast((i) => i.kind === 'assistant')?.id}`
	);
	$effect(() => {
		contextRevision;
		untrack(() => models.refresh());
	});
	$effect(() => {
		const m = models;
		const timer = setInterval(() => {
			if (!document.hidden && (s.running || sheet === 'model' || sheet === 'context')) m.refresh();
		}, 15_000);
		return () => clearInterval(timer);
	});

	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online || offlineBrowsing.unreachable) return { kind: 'offline' };
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

	function openSheet(next: ChatSheet, arg?: string) {
		if (next === 'model') {
			models.refresh();
			modelRole = 'main';
		}
		sheets[next].openWith(arg);
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
		threads.clearError();
		branch.openWith();
	}

	async function startThread(name: string) {
		const id = await threads.branch(branchFrom?.id ?? '', name);
		if (!id) return;
		await leaveSheet(branch);
		await goto(resolve('/chats/[id]', { id }));
	}
</script>

<svelte:head><title>Chat · sushii</title></svelte:head>

{#snippet backgroundActivity()}<BackgroundAgents
		onrun={(id) => goto(resolve('/runs/[id]', { id }))}
		compact
	/>{/snippet}
{#snippet delegatedActivity(turnId: string)}<BackgroundAgents
		onrun={(id) => goto(resolve('/runs/[id]', { id }))}
		{turnId}
	/>{/snippet}

{#snippet browserPreview()}
	<BrowserPreviewPanel
		status={browser.status}
		frame={browser.frame}
		hidden={browser.hidden}
		expanded={browserSheet.open}
		reconnecting={browser.reconnecting}
		stale={browser.stale}
		onhide={() => browser.hide()}
		onshow={() => browser.show()}
		onexpand={() => browserSheet.openWith()}
		onclose={() => browserSheet.close()}
		onframe={(seq) => browser.ack(seq)}
	/>
{/snippet}

{#snippet voiceStatus()}
	<VoiceCallBar
		state={voice.state}
		muted={voice.muted}
		seconds={voice.seconds}
		agentWorking={voice.agentWorking}
		captionsVisible={voice.captionsVisible}
		error={voice.error}
		onmute={() => voice.mute()}
		onstop={() => voice.stop()}
		oncaptions={() => (voice.captionsVisible = !voice.captionsVisible)}
		ondetails={() => voiceSheet.openWith()}
	/>
{/snippet}
{#snippet voiceCaptions()}
	{#if voice.captionsVisible && voice.state !== 'idle'}<VoiceCaptions
			userText={voice.userText}
			userFinal={voice.userFinal}
			assistantText={voice.assistantText}
			assistantFinal={voice.assistantFinal}
		/>{/if}
{/snippet}

{#snippet voiceControls()}
	<VoiceControl
		{voice}
		open={voiceSheet.open}
		onopen={() => voiceSheet.openWith()}
		onclose={() => voiceSheet.close()}
		onstarting={() => dictation.cancel()}
		onactive={(active) => (voiceActive = active)}
	/>
{/snippet}

<ChatScreen
	contextBoundaryId={sheets['context-boundary'].arg}
	title="Sushii"
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
	dictation={{
		state: dictation.state,
		seconds: dictation.seconds,
		error: dictation.error,
		disabled: voiceActive
	}}
	ondictate={() => dictation.toggle()}
	voice={voiceControls}
	{voiceStatus}
	{browserPreview}
	{voiceCaptions}
	voiceHasContent={voice.state !== 'idle' && !!(voice.userText || voice.assistantText)}
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
	onbranch={openBranch}
	onopensheet={openSheet}
	onclosesheet={closeSheet}
	onopenfile={(f) => {
		viewer = f;
		openSheet('viewer');
	}}
	ondraft={(v) => s.setDraft(v)}
	onsend={() => void s.send(s.draft)}
	onstop={() => s.stopTurn()}
	oncommand={async (c) => {
		await s.command(c);
		models.refresh();
	}}
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
	onreload={() => pwa.reload()}
/>
<ClearNotifications store={s} />

<BranchSheet
	open={branch.open}
	quote={branchFrom?.quote}
	bind:title={threadTitle}
	busy={threads.busy}
	error={threads.error}
	onstart={(name) => void startThread(name)}
	onclose={() => branch.close()}
/>
