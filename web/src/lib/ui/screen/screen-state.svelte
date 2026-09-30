<script lang="ts" module>
	import type { Snippet } from 'svelte';

	export interface RemoteLike {
		status: 'idle' | 'loading' | 'ready' | 'error';
		slow?: boolean;
		error?: string | null;
	}

	export interface EmptyState {
		/** What will appear here. */
		title: string;
		body: string;
		action?: { label: string; onclick: () => void };
	}
</script>

<script lang="ts">
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import WifiOff from '@lucide/svelte/icons/wifi-off';
	import { Button } from '$lib/ui/button';
	import * as Empty from '$lib/ui/empty';

	let {
		remote,
		isEmpty = false,
		empty,
		offline = false,
		errorTitle = "Couldn't load this.",
		onretry,
		skeleton,
		children
	}: {
		remote: RemoteLike;
		/** Loaded, but nothing to show. */
		isEmpty?: boolean;
		empty?: EmptyState;
		offline?: boolean;
		/** The first sentence of the error; the second is the error's own message. */
		errorTitle?: string;
		onretry?: () => void;
		/** Shown only once loading has been slow, so fast loads never flash. */
		skeleton?: Snippet;
		children: Snippet;
	} = $props();
</script>

{#if remote.status === 'ready' && isEmpty && empty}
	<Empty.Root>
		<Empty.Header>
			<Empty.Title>{empty.title}</Empty.Title>
			<Empty.Description>{empty.body}</Empty.Description>
		</Empty.Header>
		{#if empty.action}
			<Empty.Content>
				<Button onclick={empty.action.onclick}>{empty.action.label}</Button>
			</Empty.Content>
		{/if}
	</Empty.Root>
{:else if remote.status === 'ready'}
	{@render children()}
{:else if remote.status === 'error'}
	<div class="flex flex-col items-start gap-3" role="alert">
		{#if offline}
			<p class="flex items-center gap-2 text-sm">
				<WifiOff class="size-4 shrink-0 text-waiting" aria-hidden="true" />
				<span class="font-medium">You're offline.</span>
			</p>
		{:else}
			<p class="text-sm">
				<span class="font-medium">{errorTitle}</span>
				{remote.error}
			</p>
		{/if}
		{#if onretry}
			<Button variant="outline" onclick={onretry}><RotateCcw />Try again</Button>
		{/if}
	</div>
{:else if remote.slow}
	{#if skeleton}
		{@render skeleton()}
	{:else}
		<p role="status" class="sr-only">Loading…</p>
	{/if}
{/if}
