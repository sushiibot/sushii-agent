<script lang="ts">
	import Phone from '@lucide/svelte/icons/phone';
	import PhoneCall from '@lucide/svelte/icons/phone-call';
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/ui/button';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import VoicePanel from './components/voice-panel.svelte';
	import type { Voice } from './voice.svelte';
	let {
		voice,
		conversation = 'main',
		open,
		onopen,
		onclose,
		onstarting,
		onactive
	}: {
		voice: Voice;
		conversation?: string;
		open: boolean;
		onopen: () => void;
		onclose: () => void;
		onstarting?: () => void;
		onactive?: (active: boolean) => void;
	} = $props();
	let closeOnReady = $state(false);
	$effect(() => {
		if (closeOnReady && (voice.state === 'listening' || voice.state === 'speaking')) {
			closeOnReady = false;
			if (open) onclose();
		}
	});
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

<Button
	variant={voice.state === 'idle' ? 'ghost' : 'secondary'}
	class="size-12 px-0"
	aria-label={voice.state === 'idle'
		? 'Voice chat'
		: voice.agentWorking
			? 'Voice chat: Sushii is working'
			: voice.muted
				? 'Voice chat: microphone muted'
				: 'Voice chat: call active'}
	title={voice.state === 'idle' ? 'Voice chat' : 'Open voice call'}
	aria-haspopup="dialog"
	aria-expanded={open}
	onclick={onopen}
>
	{#if voice.state === 'idle'}<Phone class="size-5" aria-hidden="true" />{:else}<PhoneCall
			class="size-5"
			aria-hidden="true"
		/>{/if}
</Button>
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
			closeOnReady = true;
			void voice.start(conversation);
		}}
		onstop={() => voice.stop()}
		onmute={() => voice.mute()}
		onretry={() => void voice.load()}
		{onclose}
	/>
</RoutedSheet>
