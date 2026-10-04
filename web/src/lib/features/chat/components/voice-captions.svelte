<script lang="ts">
	import MessageText from './message-text.svelte';
	import Mic from '@lucide/svelte/icons/mic';
	import Volume2 from '@lucide/svelte/icons/volume-2';
	let {
		userText,
		userFinal,
		assistantText,
		assistantFinal
	}: {
		userText: string;
		userFinal: boolean;
		assistantText: string;
		assistantFinal: boolean;
	} = $props();
</script>

{#if userText || assistantText}
	<section aria-label="Voice captions" aria-live="off" class="mx-auto max-w-2xl">
		<ol class="flex min-w-0 flex-col gap-4 overflow-x-clip px-4 py-4 [overflow-wrap:anywhere]">
			{#if userText}
				<li
					class="min-w-0"
					aria-label={userFinal ? 'Your voice message' : 'Your voice message, transcribing'}
				>
					<div
						class="flex flex-col items-end gap-2 [@media(hover:hover)]:ml-auto [@media(hover:hover)]:w-fit [@media(hover:hover)]:max-w-[85%]"
					>
						<MessageText text={userText} owner partial={!userFinal} />
						<p class="flex items-center gap-1 text-xs text-muted-foreground">
							<Mic class="size-3.5" aria-hidden="true" />Voice
						</p>
					</div>
				</li>
			{/if}
			{#if assistantText}
				<li
					class="min-w-0"
					aria-label={assistantFinal ? 'Sushii voice reply' : 'Sushii voice reply, streaming'}
				>
					<MessageText text={assistantText} partial={!assistantFinal} />
					<p class="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
						<Volume2 class="size-3.5" aria-hidden="true" />Voice
					</p>
				</li>
			{/if}
		</ol>
	</section>
{/if}
