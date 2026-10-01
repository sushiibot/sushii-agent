<script lang="ts">
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Square from '@lucide/svelte/icons/square';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { Button } from '$lib/ui/button';
	import { Textarea } from '$lib/ui/textarea';
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';
	import type { PhotoDraft } from '../types';

	let {
		value = $bindable(''),
		placeholder = 'Message your agent',
		running = false,
		stopping = false,
		stop = true,
		photos = [],
		quotaFull = false,
		attach = true,
		onstop,
		onsend,
		onattach,
		onremovephoto,
		onretryphoto,
		model,
		onmodel,
		mic,
		status
	}: {
		value?: string;
		placeholder?: string;
		/** A turn is running: Send steers it, and Stop shows as its own control. */
		running?: boolean;
		stopping?: boolean;
		/** Show Stop while running. Off while an approval tray is up: Deny is the way out, and the chat keeps its room. */
		stop?: boolean;
		photos?: PhotoDraft[];
		quotaFull?: boolean;
		attach?: boolean;
		onstop?: () => void;
		onsend?: () => void;
		onattach?: (files: File[]) => void;
		onremovephoto?: (id: string) => void;
		onretryphoto?: (id: string) => void;
		/** The model the next turn uses; the chip shows it and opens the picker. */
		model?: string | null;
		onmodel?: () => void;
		/** A dictation button, placed before Send. */
		mic?: Snippet;
		/** A muted line under the box, such as the last reply's usage. */
		status?: Snippet;
	} = $props();
	const uid = $props.id();
	let picker = $state<HTMLInputElement | null>(null);

	const errors: Record<NonNullable<PhotoDraft['error']>, string> = {
		upload: 'Upload failed',
		type: 'Not a supported image (PNG, JPEG, GIF, WebP)',
		size: 'Too large (10 MB max)',
		daily: 'Daily photo limit reached. Try again tomorrow.',
		expired: 'Photo expired — re-attach'
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
	// Stop takes Send's place while the box is empty; typing brings Send back, which steers the run.
	const showStop = $derived(running && stop && !value.trim() && !photos.length);
	const hint = $derived(
		running && stop
			? stopping
				? 'Your next message starts a new turn.'
				: 'The agent is working. A message now steers this run.'
			: undefined
	);

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (canSend) onsend?.();
	}
	// Enter is a newline on a touch keyboard; Ctrl or Cmd+Enter sends from a hardware keyboard.
	function keydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSend) {
			e.preventDefault();
			onsend?.();
		}
	}

	type Tone = 'muted' | 'strong' | 'primary';
	function roundFace(tone: Tone) {
		return cn(
			'grid size-10 place-items-center rounded-full transition-colors group-focus-visible/round:ring-3 group-focus-visible/round:ring-ring/50 group-active/round:translate-y-px group-disabled/round:opacity-50',
			tone === 'primary' && 'bg-primary text-primary-foreground group-hover/round:bg-primary/80',
			tone === 'strong' && 'bg-foreground text-background group-hover/round:bg-foreground/80',
			tone === 'muted' && 'bg-muted text-foreground group-hover/round:bg-muted/70'
		);
	}
</script>

{#snippet attachIcon()}<Plus class="size-5" aria-hidden="true" />{/snippet}
{#snippet stopIcon()}
	{#if stopping}
		<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
	{:else}
		<Square class="size-3.5 fill-current" aria-hidden="true" />
	{/if}
{/snippet}

<!-- A 40px circle inside the 48px target. -->
{#snippet round(b: {
	label: string;
	disabled?: boolean;
	onclick: () => void;
	icon: Snippet;
	tone?: Tone;
})}
	<button
		type="button"
		aria-label={b.label}
		disabled={b.disabled}
		onclick={b.onclick}
		class="group/round grid size-12 shrink-0 place-items-center rounded-full outline-none select-none disabled:pointer-events-none"
	>
		<span class={roundFace(b.tone ?? 'muted')}>{@render b.icon()}</span>
	</button>
{/snippet}

<form class="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pt-2.5 pb-2.5" onsubmit={submit}>
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
						<Button
							variant="ghost"
							class="px-3"
							aria-label="Retry photo {photos.indexOf(photo) + 1}"
							onclick={() => onretryphoto?.(photo.id)}><RotateCcw />Retry</Button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if hint}<p id="{uid}-steer" class="sr-only" aria-live="polite">{hint}</p>{/if}
	{#if quotaFull}
		<p class="flex items-start gap-2 rounded-lg bg-failed-soft px-3 py-2 text-sm text-failed">
			<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Photo storage is full. Free space before sending more.
		</p>
	{/if}
	<!-- One box the width of the message column: text on top, photo and Send inside it. -->
	<div
		class="flex flex-col rounded-3xl border bg-card focus-within:ring-2 focus-within:ring-ring/40"
	>
		{#if photos.length}
			<ul aria-label="Photos to send" class="flex gap-3 overflow-x-auto px-3 pt-4 pr-5 pb-1">
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
								class="absolute inset-0 flex flex-col items-center justify-center gap-0.5 rounded-xl text-tab font-semibold text-foreground"
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
							onclick={() => onremovephoto?.(photo.id)}
						>
							<span
								class="grid size-6 place-items-center rounded-full border bg-background text-foreground shadow-sm"
								><X class="size-3.5" aria-hidden="true" /></span
							>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<label for="{uid}-composer" class="sr-only">Message</label>
		<Textarea
			id="{uid}-composer"
			rows={1}
			bind:value
			{placeholder}
			onkeydown={keydown}
			aria-describedby={blocked ? `${uid}-blocked` : undefined}
			class="max-h-40 min-h-12 resize-none rounded-none border-0 bg-transparent px-4 pt-3 pb-1 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
		/>
		<div class="flex items-center gap-0.5 px-1 pb-1">
			{#if attach}
				<input
					bind:this={picker}
					type="file"
					accept="image/*"
					multiple
					hidden
					onchange={(e) => {
						const input = e.currentTarget;
						if (input.files?.length) onattach?.([...input.files]);
						input.value = '';
					}}
				/>
				{@render round({
					label: 'Attach photos',
					disabled: quotaFull,
					onclick: () => picker?.click(),
					icon: attachIcon
				})}
			{/if}
			{#if model && onmodel}
				<!-- A 36px pill inside the 48px target, like the round buttons. -->
				<button
					type="button"
					aria-haspopup="dialog"
					aria-label="Model: {model}. Change model"
					onclick={onmodel}
					class="group/chip flex h-12 min-w-0 items-center outline-none"
				>
					<span
						class="flex h-9 min-w-0 items-center gap-1 rounded-full bg-muted px-3.5 text-sm text-foreground transition-colors group-hover/chip:bg-muted/70 group-focus-visible/chip:ring-3 group-focus-visible/chip:ring-ring/50"
					>
						<span class="truncate">{model}</span>
						<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					</span>
				</button>
			{/if}
			<div class="ml-auto flex shrink-0 items-center gap-0.5">
				{@render mic?.()}
				{#if showStop}
					{@render round({
						label: stopping ? 'Stopping…' : 'Stop',
						disabled: stopping,
						onclick: () => onstop?.(),
						icon: stopIcon,
						tone: 'strong'
					})}
				{:else}
					<button
						type="submit"
						aria-label="Send message"
						aria-describedby={hint ? `${uid}-steer` : undefined}
						class="group/round grid size-12 shrink-0 place-items-center rounded-full outline-none select-none disabled:pointer-events-none"
						disabled={!canSend}
					>
						<span class={roundFace('primary')}><ArrowUp class="size-4.5" aria-hidden="true" /></span
						>
					</button>
				{/if}
			</div>
		</div>
	</div>
	{#if blocked}
		<p id="{uid}-blocked" class="px-1 text-xs text-muted-foreground">{blocked}</p>
	{/if}
	{@render status?.()}
</form>
