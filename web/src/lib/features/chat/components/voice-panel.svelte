<script lang="ts">
	import { Button } from '$lib/ui/button';
	import type { VoiceModel } from '../types';
	let {
		models,
		provider,
		loading,
		state,
		error,
		muted,
		agentWorking,
		userText,
		assistantText,
		seconds,
		onprovider,
		onstart,
		onstop,
		onmute,
		onretry,
		onclose
	}: {
		models: VoiceModel[];
		provider: string;
		loading: boolean;
		state: 'idle' | 'connecting' | 'listening' | 'speaking';
		error: string | null;
		muted: boolean;
		agentWorking: boolean;
		userText: string;
		assistantText: string;
		seconds: number;
		onprovider: (id: string) => void;
		onstart: () => void;
		onstop: () => void;
		onmute: () => void;
		onretry: () => void;
		onclose: () => void;
	} = $props();
	const active = $derived(state !== 'idle');
	const selected = $derived(models.find((m) => m.id === provider));
	const status = $derived(
		state === 'connecting'
			? 'Connecting…'
			: muted
				? 'Microphone muted'
				: agentWorking
					? 'Sushii is working — you can keep talking'
					: state === 'speaking'
						? 'Speaking — interrupt anytime'
						: 'Listening'
	);
</script>

<div class="flex flex-col gap-4 p-4">
	<div class="flex items-center justify-between gap-2">
		<h2 class="text-lg font-semibold">Voice chat</h2>
		<Button variant="ghost" onclick={onclose}>Back to chat</Button>
	</div>
	<p class="text-sm text-muted-foreground">
		Talk naturally and interrupt anytime. Sushii uses the same memory, tools and approvals as this
		chat.
	</p>
	<div class="flex flex-col gap-2">
		<label for="voice-provider" class="text-sm font-medium">Voice provider</label>
		<select
			id="voice-provider"
			class="h-12 w-full rounded-lg border bg-background px-3 text-sm"
			value={provider}
			disabled={active || loading}
			onchange={(event) => onprovider(event.currentTarget.value)}
		>
			{#if !provider}<option value="">Choose a configured provider</option>{/if}
			{#each models as model}
				<option value={model.id} disabled={!model.configured}
					>{model.name}{model.configured ? '' : ' (not configured)'}</option
				>
			{/each}
		</select>
		{#if selected}
			<p class="text-xs text-muted-foreground">
				Audio: ${selected.audioInputUsd} input / ${selected.audioOutputUsd} output per million tokens.
				Text, transcription and agent usage may add costs.
			</p>
		{/if}
	</div>
	{#if loading}<p role="status" class="text-sm text-muted-foreground">
			Loading voice providers…
		</p>{/if}
	{#if !loading && !models.some((m) => m.configured)}
		<p class="text-sm text-muted-foreground">
			Voice needs a provider API key on the server. Dictation is still available in the composer.
		</p>
	{/if}
	{#if error}<p role="alert" class="text-sm text-failed">{error}</p>{/if}
	{#if active}
		<p role="status" class="text-sm font-medium">
			{status} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
		</p>
		{#if userText}<p class="text-sm"><span class="font-medium">You:</span> {userText}</p>{/if}
		{#if assistantText}<p class="max-h-40 overflow-y-auto text-sm">
				<span class="font-medium">Sushii:</span>
				{assistantText}
			</p>{/if}
		<div class="flex gap-2">
			<Button variant="outline" disabled={state === 'connecting'} onclick={onmute}
				>{muted ? 'Unmute microphone' : 'Mute microphone'}</Button
			>
			<Button variant="outline" onclick={onstop}>End call</Button>
		</div>
		<p class="text-xs text-muted-foreground">
			Use Back to chat for approvals while the call stays open. Calls end when you leave the app or
			after 15 minutes.
		</p>
	{:else}
		<div class="flex gap-2">
			<Button disabled={loading || !selected?.configured} onclick={onstart}>Start voice chat</Button
			>
			{#if error || !models.some((m) => m.configured)}<Button variant="outline" onclick={onretry}
					>Retry</Button
				>{/if}
		</div>
	{/if}
</div>
