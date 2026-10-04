<script lang="ts">
	import { BrowserPreview, BrowserPreviewPanel } from '$lib/features/browser';
	import { goto } from '$app/navigation';
	import { BackgroundAgents } from '$lib/features/runs';
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { leaveSheet, routedSheet } from '$lib/core/nav/sheet';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import {
		modelsStore,
		Dictation,
		VoiceControl,
		Voice,
		VoiceCallBar,
		VoiceCaptions,
		type ChatSheet,
		type FileRef
	} from '$lib/features/chat';
	import {
		ThreadScreen,
		threadMessages,
		threadsStore,
		type ThreadSheet
	} from '$lib/features/threads';

	const threads = threadsStore();
	const goBack = backTo(resolve('/chats'));
	const id = $derived(page.params.id ?? '');
	const remote = $derived(threads.thread(id));
	const detail = $derived(remote.data);
	const store = $derived(detail ? threads.chat(detail) : null);
	const browserSheet = routedSheet('browser-preview');
	const browser = $derived(new BrowserPreview(id));
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
	const dictation = new Dictation((text) => {
		if (!store) return;
		const draft = store.draft.trimEnd();
		store.setDraft(draft ? `${draft} ${text}` : text);
	});
	$effect(() => {
		id;
		return () => dictation.cancel();
	});
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => void r.ensure());
	});
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	$effect(() => {
		const s = store;
		if (!s) return;
		untrack(() => s.setViewing(true));
		return () => s.setViewing(false);
	});

	const models = $derived(modelsStore(id));
	let modelRole = $state<'main' | 'fallback'>('main');
	$effect(() => {
		const m = models;
		untrack(() => void m.remote.ensure());
		return m.remote.watch();
	});

	type AnySheet = ChatSheet | Exclude<ThreadSheet, 'branch'>;
	const ids: AnySheet[] = [
		'commands',
		'new',
		'viewer',
		'model',
		'thread-memory',
		'thread-close',
		'thread-settings'
	];
	const sheets = Object.fromEntries(ids.map((s) => [s, routedSheet(s)])) as Record<
		AnySheet,
		ReturnType<typeof routedSheet>
	>;
	const sheet = $derived(ids.find((s) => sheets[s].open));
	$effect(() => {
		if (sheet !== 'model') return;
		const m = models;
		untrack(() => m.refresh());
		const timer = setInterval(() => {
			if (!document.hidden) m.refresh();
		}, 15_000);
		return () => clearInterval(timer);
	});
	const closeSheet = () => {
		if (sheet) sheets[sheet].close();
	};

	async function closeThread() {
		if (!(await threads.close(id))) return;
		await leaveSheet(sheet ? sheets[sheet] : undefined);
	}
</script>

<svelte:head><title>{detail?.summary.title ?? 'Thread'} · sushii</title></svelte:head>

{#snippet backgroundActivity()}<BackgroundAgents
		onrun={(id) => goto(resolve('/runs/[id]', { id }))}
		conversationId={id}
		compact
	/>{/snippet}
{#snippet delegatedActivity(turnId: string)}<BackgroundAgents
		onrun={(id) => goto(resolve('/runs/[id]', { id }))}
		conversationId={id}
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
		conversation={id}
		open={voiceSheet.open}
		onopen={() => voiceSheet.openWith()}
		onclose={() => voiceSheet.close()}
		onstarting={() => dictation.cancel()}
		onactive={(active) => (voiceActive = active)}
	/>
{/snippet}

<ThreadScreen
	{remote}
	{detail}
	{now}
	{sheet}
	busy={threads.busy}
	error={threads.error}
	sendable={threads.canSend}
	back={{ href: resolve('/chats'), label: 'Back to Threads', onclick: goBack }}
	writeHref={(w) => resolve('/memory/writes/[id]', { id: w })}
	memoryHref={resolve('/memory/writes')}
	chat={store
		? {
				approvals: store.approvals,
				messages: threadMessages(detail!, store.messages),
				history: store.history,
				hasOlder: store.hasOlder,
				olderLoading: store.olderLoading,
				backgroundActivity,
				delegatedActivity,
				approvalSubmitting: store.trayPhase === 'submitting',
				olderError: store.olderError,
				running: store.running,
				stopping: store.stopping,
				draft: store.draft,
				photos: store.photos,
				quotaFull: store.quotaFull,
				dictation: {
					state: dictation.state,
					seconds: dictation.seconds,
					error: dictation.error,
					disabled: voiceActive
				},
				ondictate: () => dictation.toggle(),
				voice: voiceControls,
				voiceStatus,
				browserPreview,
				voiceCaptions,
				voiceHasContent: voice.state !== 'idle' && !!(voice.userText || voice.assistantText),
				usage: store.usage,
				models: models.remote.data ?? null,
				modelPicking: models.picking,
				modelError: models.error,
				modelRole,
				modelQuery: models.query,
				modelResults: models.results,
				modelSearching: models.searching,
				modelSearchError: models.searchError,
				onmodelrole: (r) => (modelRole = r),
				onmodelquery: (q) => models.setQuery(q),
				onpickmodel: (alias, role) =>
					void models.pick(alias, role).then((ok) => ok && closeSheet()),
				connection: !pwa.online
					? { kind: 'offline' }
					: store.workspace === 'offline'
						? { kind: 'agent-offline' }
						: store.reset
							? { kind: 'reset' }
							: undefined,
				toast: store.toast,
				announce: store.announce,
				viewer,
				onopensheet: (s) => {
					if (s === 'model') {
						models.refresh();
						modelRole = 'main';
					}
					sheets[s].openWith();
				},
				onclosesheet: closeSheet,
				onopenfile: (f) => {
					viewer = f;
					sheets.viewer.openWith();
				},
				ondraft: (v) => store.setDraft(v),
				onsend: () => void store.send(store.draft),
				onstop: () => store.stopTurn(),
				oncommand: (c) => store.command(c),
				onattach: (files) => void store.attach(files),
				onremovephoto: (p) => store.removePhoto(p),
				onretryphoto: (p) => store.retryPhoto(p),
				onloadolder: () => store.loadOlder(),
				onretryhistory: () => store.retryHistory(),
				onretrysend: (m) => store.retry(m),
				onsteersend: (m) => store.steerNow(m),
				ondeletesend: (m) => void store.discard(m),
				onanswer: (askId, answer) => store.answer(askId, answer),
				onapprove: (nonce, location) => void store.decide(nonce, 'approve', location),
				ondeny: (nonce) => void store.decide(nonce, 'deny')
			}
		: undefined}
	onopensheet={(s) => {
		threads.clearError();
		if (s !== 'branch') sheets[s].openWith();
	}}
	onclosesheet={closeSheet}
	onclose={() => void closeThread()}
	onrename={async (title) => {
		if (await threads.rename(id, title)) await leaveSheet(sheets['thread-settings']);
	}}
	onreopen={() => void threads.reopen(id)}
	onretry={() => void remote.refetch()}
/>
