<script lang="ts">
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import FileCode from '@lucide/svelte/icons/file-code';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { Button } from '$lib/components/ui/button';
	import type { FileRef } from './types';

	let {
		files,
		dropped,
		onopen
	}: { files: FileRef[]; dropped?: string; onopen?: (file: FileRef) => void } = $props();

	const images = $derived(files.filter((f) => f.image));
	const others = $derived(files.filter((f) => !f.image));
	const codeLike = (name: string) => /\.(html?|svg|js|mjs|css|json|xml)$/i.test(name);
</script>

<div class="flex flex-col gap-2">
	{#if images.length}
		<ul class="flex flex-wrap gap-2">
			{#each images as file (file.id)}
				<li>
					{#if file.removed || !file.src}
						<span
							class="flex h-24 w-32 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-xs text-muted-foreground"
						>
							<ImageOff class="size-4" aria-hidden="true" />Image removed
						</span>
					{:else}
						<button
							type="button"
							onclick={() => onopen?.(file)}
							class="block overflow-hidden rounded-xl border"
							aria-label="Open image {file.name}"
						>
							<img src={file.src} alt="" class="h-40 w-auto max-w-full object-cover" />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#each others as file (file.id)}
		{@const Icon = codeLike(file.name) ? FileCode : FileText}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-2 pl-3">
			<Icon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span class="flex min-w-0 flex-1 basis-40 flex-col">
				<span class="text-sm font-medium [overflow-wrap:anywhere]">{file.name}</span>
				<span class="text-xs text-muted-foreground">{file.size} · Download to open</span>
			</span>
			<Button
				variant="outline"
				class="ml-auto px-4"
				href="/f/{file.id}"
				download={file.name}
				aria-label="Download {file.name}"><Download />Download</Button
			>
		</div>
	{/each}
	{#if dropped}
		<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
			<CircleAlert class="mt-0.5 size-3.5 shrink-0 text-waiting" aria-hidden="true" />{dropped}
		</p>
	{/if}
</div>
