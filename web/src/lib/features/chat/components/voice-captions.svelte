<script lang="ts">
	let {
		userText,
		userFinal,
		assistantText
	}: { userText: string; userFinal: boolean; assistantText: string } = $props();
</script>

{#if userText || assistantText}
	<section aria-label="Voice captions" aria-live="off" class="mx-auto max-w-2xl px-4 py-3">
		<div
			class="flex max-h-32 flex-col gap-2 overflow-y-auto rounded-lg border px-3 py-2 text-sm [overflow-wrap:anywhere]"
		>
			{#if userText}<p>
					<span class="font-medium">You{userFinal ? '' : ' · Transcribing…'}:</span>
					{userText}
				</p>{/if}
			{#if assistantText}<p><span class="font-medium">Sushii:</span> {assistantText}</p>{/if}
		</div>
		<p class="pt-1 text-xs text-muted-foreground">Live captions · may be revised</p>
	</section>
{/if}
