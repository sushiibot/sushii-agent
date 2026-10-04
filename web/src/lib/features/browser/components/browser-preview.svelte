<script lang="ts">
	import Monitor from '@lucide/svelte/icons/monitor';
	import Maximize from '@lucide/svelte/icons/maximize';
	import X from '@lucide/svelte/icons/x';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';
	import { Dialog } from 'bits-ui';
	import { Button } from '$lib/ui/button';
	import type { BrowserPreviewFrame, BrowserPreviewStatus } from '../preview-types';

	let {
		status,
		frame,
		hidden,
		expanded,
		reconnecting,
		stale,
		onhide,
		onshow,
		onexpand,
		onclose,
		onframe
	}: {
		status: BrowserPreviewStatus | null;
		frame: BrowserPreviewFrame | null;
		hidden: boolean;
		expanded: boolean;
		reconnecting: boolean;
		stale: boolean;
		onhide: () => void;
		onshow: () => void;
		onexpand: () => void;
		onclose: () => void;
		onframe: (seq: number) => void;
	} = $props();
	let zoomed = $state(false);
	let details = $state(false);
	const hostname = $derived.by(() => {
		try {
			return status?.url ? new URL(status.url).hostname || 'Browser' : 'Browser';
		} catch {
			return 'Browser';
		}
	});
	const label = $derived(
		status?.state === 'ended'
			? 'Finished'
			: reconnecting
				? 'Reconnecting…'
				: stale
					? 'Preview paused'
					: frame
						? 'Live'
						: 'Opening browser…'
	);
	const source = $derived(frame ? `data:image/jpeg;base64,${frame.data}` : undefined);
	$effect(() => {
		if (!expanded) zoomed = false;
	});
</script>

{#if status}
	<section aria-label="Browser preview" class="shrink-0 border-b bg-muted/30">
		<div class="flex min-h-12 items-center gap-2 px-3">
			<Monitor class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{hostname}</p>
				<p role="status" class="text-meta text-muted-foreground">{label}</p>
			</div>
			{#if hidden}
				{#if status.state !== 'ended'}<Button variant="ghost" onclick={onshow}>Show</Button>{/if}
			{:else}
				<Button
					variant="ghost"
					class="size-12 px-0"
					aria-label="Expand browser preview"
					disabled={!frame}
					onclick={onexpand}><Maximize aria-hidden="true" /></Button
				>
				<Button
					variant="ghost"
					class="size-12 px-0"
					aria-label="Hide browser preview"
					onclick={onhide}><X aria-hidden="true" /></Button
				>
			{/if}
		</div>
		{#if frame && !hidden && !expanded}
			<div class="relative bg-muted">
				<img
					src={source}
					alt={`Agent browser at ${hostname}`}
					class="mx-auto max-h-48 w-full object-contain"
					onload={() => onframe(frame!.seq)}
				/>
				{#if reconnecting || stale || status.state === 'ended'}<p
						class="absolute right-2 bottom-2 rounded-md bg-background px-2 py-1 text-meta"
					>
						{label} · last frame
					</p>{/if}
			</div>
			<p class="truncate px-3 py-1 text-meta text-muted-foreground">{status.action}</p>
		{/if}
	</section>
{/if}

<Dialog.Root
	open={expanded}
	onOpenChange={(open) => {
		if (!open) onclose();
	}}
>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-50 bg-scrim" />
		<Dialog.Content
			aria-label="Browser screen"
			class="fixed inset-x-0 top-0 bottom-(--kb) z-50 flex flex-col bg-background pt-(--safe-top) pb-(--safe-bottom) text-foreground outline-none"
		>
			<div class="flex shrink-0 items-center gap-2 border-b px-3">
				<Dialog.Title class="min-w-0 flex-1 truncate text-sm font-medium"
					>{hostname} · {label}</Dialog.Title
				>
				<Button
					variant="ghost"
					aria-label={zoomed ? 'Fit browser screen' : 'Zoom browser screen'}
					aria-pressed={zoomed}
					onclick={() => (zoomed = !zoomed)}
					>{#if zoomed}<ZoomOut aria-hidden="true" />{:else}<ZoomIn
							aria-hidden="true"
						/>{/if}</Button
				>
				<Button
					variant="ghost"
					class="size-12 px-0"
					aria-label="Close browser screen"
					onclick={onclose}><X aria-hidden="true" /></Button
				>
			</div>
			<Dialog.Description class="sr-only"
				>Watch the agent's browser. This preview is read-only.</Dialog.Description
			>
			<div class="flex min-h-0 flex-1 items-center overflow-auto overscroll-contain bg-muted">
				{#if frame}<img
						src={source}
						alt={`Agent browser at ${hostname}`}
						class={zoomed ? 'max-w-none shrink-0' : 'max-h-full w-full object-contain'}
						width={zoomed ? frame.width : undefined}
						height={zoomed ? frame.height : undefined}
						onload={() => onframe(frame!.seq)}
					/>
				{:else}<p role="status" class="m-auto text-sm text-muted-foreground">
						Waiting for the browser screen…
					</p>{/if}
			</div>
			<div class="shrink-0 border-t px-3">
				<div class="flex items-center justify-between gap-2">
					<p class="truncate text-sm">{status?.action ?? 'Browser finished'}</p>
					<Button variant="ghost" aria-expanded={details} onclick={() => (details = !details)}
						>Details</Button
					>
				</div>
				{#if details}<p class="pb-3 text-meta [overflow-wrap:anywhere] text-muted-foreground">
						{status?.url ?? 'No page address'} · Read-only
					</p>{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
