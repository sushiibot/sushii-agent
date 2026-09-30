<script lang="ts">
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Square from '@lucide/svelte/icons/square';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import X from '@lucide/svelte/icons/x';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { cn } from '$lib/utils';
	import type { PhotoDraft } from './types';

	let {
		value = '',
		placeholder = 'Message your agent',
		running = false,
		stopping = false,
		photos = [],
		quotaFull = false,
		attach = true,
		onstop
	}: {
		value?: string;
		placeholder?: string;
		/** A turn is running: Stop takes Send's place. */
		running?: boolean;
		stopping?: boolean;
		photos?: PhotoDraft[];
		quotaFull?: boolean;
		attach?: boolean;
		onstop?: () => void;
	} = $props();
	const uid = $props.id();

	const errors: Record<NonNullable<PhotoDraft['error']>, string> = {
		upload: 'Upload failed',
		type: 'Not a supported image (PNG, JPEG, GIF, WebP)',
		size: 'Too large (10 MB max)'
	};
	const pending = $derived(
		photos.filter((p) => p.state === 'preparing' || p.state === 'uploading')
	);
	const failed = $derived(photos.filter((p) => p.state === 'failed'));
	const blocked = $derived(
		failed.length
			? `Send is off: remove or retry ${failed.length === 1 ? 'the failed photo' : `${failed.length} failed photos`}.`
			: pending.length
				? `Send is off until ${pending.length === 1 ? '1 photo finishes' : `${pending.length} photos finish`} uploading.`
				: undefined
	);
	const canSend = $derived(!blocked && (!!value.trim() || photos.length > 0));
</script>

<form class="flex flex-col gap-2 px-3 py-2.5" onsubmit={(e) => e.preventDefault()}>
	{#if photos.length}
		<ul aria-label="Photos to send" class="-mx-3 flex gap-3 overflow-x-auto pt-4 pr-5 pb-1 pl-3">
			{#each photos as photo, i (photo.id)}
				<li class="relative shrink-0">
					<img
						src={photo.src}
						alt="Photo {i + 1}"
						class={cn(
							'size-18 rounded-xl border object-cover',
							photo.state !== 'uploaded' && 'opacity-45'
						)}
					/>
					{#if photo.state === 'preparing' || photo.state === 'uploading'}
						<span
							class="absolute inset-0 flex flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold text-foreground"
						>
							<LoaderCircle
								class="size-4 animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>
							{photo.state === 'preparing' ? 'Preparing' : `Uploading ${photo.progress ?? 0}%`}
						</span>
						{#if photo.state === 'uploading'}
							<span
								class="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-foreground/15"
								aria-hidden="true"
							>
								<span
									class="block h-full rounded-full bg-foreground"
									style="width: {photo.progress ?? 0}%"
								></span>
							</span>
						{/if}
					{:else if photo.state === 'failed'}
						<span class="absolute inset-0 grid place-items-center rounded-xl">
							<CircleAlert class="size-6 text-failed" aria-label="Failed" />
						</span>
					{/if}
					<button
						type="button"
						aria-label="Remove photo {i + 1}"
						class="absolute -top-4 -right-4 grid size-12 place-items-center"
					>
						<span
							class="grid size-6 place-items-center rounded-full border bg-background text-foreground shadow-sm"
							><X class="size-3.5" aria-hidden="true" /></span
						>
					</button>
				</li>
			{/each}
		</ul>
		{#if failed.length}
			<ul class="flex flex-col gap-1">
				{#each failed as photo (photo.id)}
					<li class="flex items-center gap-2 text-sm">
						<CircleAlert class="size-4 shrink-0 text-failed" aria-hidden="true" />
						<span class="min-w-0 flex-1"
							><span class="font-medium">Photo {photos.indexOf(photo) + 1}:</span>
							{errors[photo.error ?? 'upload']}</span
						>
						{#if photo.error === 'upload'}
							<Button variant="ghost" class="px-3"><RotateCcw />Retry</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
	{#if quotaFull}
		<p class="flex items-start gap-2 rounded-lg bg-failed-soft px-3 py-2 text-sm text-failed">
			<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Photo storage is full. Free space before sending more.
		</p>
	{/if}
	<div class="flex items-end gap-2">
		{#if attach}
			<Button
				variant="ghost"
				class="size-12 shrink-0 rounded-full px-0"
				aria-label="Attach photos"
				disabled={quotaFull}><ImagePlus class="size-5" /></Button
			>
		{/if}
		<label for="{uid}-composer" class="sr-only">Message</label>
		<Textarea
			id="{uid}-composer"
			rows={1}
			{value}
			{placeholder}
			aria-describedby={blocked ? `${uid}-blocked` : undefined}
			class="max-h-40 min-h-12 flex-1 resize-none rounded-3xl bg-card px-4 py-3 text-base kb:ring-2 kb:ring-ring/40"
		/>
		{#if running}
			<Button
				variant="outline"
				class="size-12 shrink-0 rounded-full border-foreground/40 px-0"
				aria-label={stopping ? 'Stopping' : 'Stop the agent'}
				disabled={stopping}
				onclick={onstop}
			>
				{#if stopping}<LoaderCircle
						class="size-5 animate-spin motion-reduce:animate-none"
					/>{:else}<Square class="size-4 fill-current" />{/if}
			</Button>
		{:else}
			<Button
				type="submit"
				aria-label="Send message"
				class="size-12 shrink-0 rounded-full px-0"
				disabled={!canSend}><ArrowUp class="size-5" /></Button
			>
		{/if}
	</div>
	{#if blocked}
		<p id="{uid}-blocked" class="px-1 text-xs text-muted-foreground">{blocked}</p>
	{/if}
</form>
