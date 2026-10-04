<script lang="ts">
	import Mic from '@lucide/svelte/icons/mic';
	import MicOff from '@lucide/svelte/icons/mic-off';
	import PhoneOff from '@lucide/svelte/icons/phone-off';
	import Captions from '@lucide/svelte/icons/captions';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import { Button } from '$lib/ui/button';
	let {
		state,
		muted,
		seconds,
		agentWorking,
		captionsVisible,
		error,
		onmute,
		onstop,
		oncaptions,
		ondetails
	}: {
		state: 'idle' | 'connecting' | 'listening' | 'speaking';
		muted: boolean;
		seconds: number;
		agentWorking: boolean;
		captionsVisible: boolean;
		error: string | null;
		onmute: () => void;
		onstop: () => void;
		oncaptions: () => void;
		ondetails: () => void;
	} = $props();
</script>

{#if state !== 'idle'}
	<section aria-label="Voice call" class="shrink-0 border-b bg-muted/30 px-3 py-1">
		<div class="flex items-center justify-between gap-2">
			<p class="min-w-0 text-sm font-medium">
				<span role="status">
					{state === 'connecting'
						? 'Connecting…'
						: muted
							? 'Microphone muted'
							: state === 'speaking'
								? 'Speaking'
								: 'Listening'}
				</span>
				<span class="text-xs text-muted-foreground" aria-live="off">
					· {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
				</span>
			</p>
			<div class="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					class="size-12 px-0"
					aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
					aria-pressed={muted}
					disabled={state === 'connecting'}
					onclick={onmute}
					>{#if muted}<MicOff aria-hidden="true" />{:else}<Mic aria-hidden="true" />{/if}</Button
				>
				<Button
					variant="ghost"
					class="size-12 px-0"
					aria-label="Show voice captions"
					aria-pressed={captionsVisible}
					onclick={oncaptions}><Captions aria-hidden="true" /></Button
				>
				<Button variant="ghost" class="size-12 px-0" aria-label="End call" onclick={onstop}
					><PhoneOff aria-hidden="true" /></Button
				>
			</div>
		</div>
		{#if agentWorking}<p role="status" class="pb-1 text-xs text-muted-foreground">
				Sushii is working · tools and approvals appear in chat
			</p>{/if}
	</section>
{:else if error}
	<div class="flex items-center justify-between gap-2 border-b px-3 py-1">
		<p role="alert" class="text-sm text-failed">{error}</p>
		<Button variant="ghost" class="size-12 px-0" aria-label="Voice settings" onclick={ondetails}
			><Settings2 aria-hidden="true" /></Button
		>
	</div>
{/if}
