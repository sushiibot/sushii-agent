<script lang="ts">
	import Headphones from '@lucide/svelte/icons/headphones';
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/ui/button';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import VoicePanel from './components/voice-panel.svelte';
	import { Voice } from './voice.svelte';
	let {
		conversation = 'main',
		open,
		onopen,
		onclose,
		onstarting,
		onactive
	}: {
		conversation?: string;
		open: boolean;
		onopen: () => void;
		onclose: () => void;
		onstarting?: () => void;
		onactive?: (active: boolean) => void;
	} = $props();
	const voice = new Voice();
	$effect(() => {
		onactive?.(voice.state !== 'idle');
	});
	$effect(() => {
		if (open) void voice.load();
	});
	$effect(() => {
		conversation;
		return () => voice.stop();
	});
	onDestroy(() => voice.stop());
</script>

<div class="flex items-center justify-between gap-2 px-2">
	<Button variant="ghost" onclick={onopen}>
		<Headphones class="size-4" aria-hidden="true" />
		{voice.state === 'idle'
			? 'Voice chat'
			: voice.agentWorking
				? 'Voice · working'
				: voice.muted
					? 'Voice · muted'
					: 'Voice · call active'}
	</Button>
	{#if voice.state !== 'idle'}<Button variant="ghost" onclick={() => voice.stop()}>End call</Button
		>{/if}
</div>
<RoutedSheet {open} label="Voice chat" {onclose}>
	<VoicePanel
		models={voice.models}
		provider={voice.provider}
		loading={voice.loading}
		state={voice.state}
		error={voice.error}
		muted={voice.muted}
		agentWorking={voice.agentWorking}
		userText={voice.userText}
		assistantText={voice.assistantText}
		seconds={voice.seconds}
		onprovider={(id) => (voice.provider = id)}
		onstart={() => {
			onstarting?.();
			void voice.start(conversation);
		}}
		onstop={() => voice.stop()}
		onmute={() => voice.mute()}
		onretry={() => void voice.load()}
		{onclose}
	/>
</RoutedSheet>
