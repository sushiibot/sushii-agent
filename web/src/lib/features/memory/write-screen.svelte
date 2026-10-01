<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Redo2 from '@lucide/svelte/icons/redo-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import DiffView from '$lib/ui/diff/diff-view.svelte';
	import { ago } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { MemoryWriteRecord } from './types';

	let {
		remote,
		write,
		now,
		back,
		online = true,
		busy = false,
		result = null,
		runHref = (id) => `/runs/${id}`,
		threadHref = (id) => `/chats/${id}`,
		fileHref = (id) => `/memory/files/${id}`,
		onrevert,
		onrestore,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no such change. */
		write?: MemoryWriteRecord | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		busy?: boolean;
		/** What the last revert or restore did, for the toast. */
		result?: { kind: 'reverted' | 'restored' | 'failed'; text: string } | null;
		runHref?: (id: string) => string;
		threadHref?: (id: string) => string;
		fileHref?: (id: string) => string;
		onrevert?: () => void;
		onrestore?: () => void;
		onretry?: () => void;
	} = $props();
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-3 w-1/3" />
		<Skeleton class="h-6 w-4/5" />
		<Skeleton class="h-28 w-full rounded-xl" />
	</div>
	<p role="status" class="sr-only">Loading the change…</p>
{/snippet}

{#snippet toast()}
	<span class="flex-1">{result?.text}</span>
	{#if result?.kind === 'reverted'}
		<button
			type="button"
			class="-my-3 h-12 shrink-0 font-semibold underline underline-offset-2"
			onclick={onrestore}>Restore</button
		>
	{/if}
{/snippet}

{#snippet footer()}
	{#if write}
		<div class="flex flex-col gap-2 border-t px-4 py-3">
			{#if write.reverted}
				<Button size="lg" variant="outline" disabled={busy || !online} onclick={onrestore}>
					{#if busy}<LoaderCircle
							class="animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>Restoring…{:else}<Redo2 />Restore this change{/if}
				</Button>
			{:else}
				<Button size="lg" variant="outline" disabled={busy || !online} onclick={onrevert}>
					{#if busy}<LoaderCircle
							class="animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>Reverting…{:else}<Undo2 />Revert this change{/if}
				</Button>
			{/if}
			{#if !online}
				<p class="text-center text-meta text-muted-foreground">
					You're offline. Undo needs the agent.
				</p>
			{/if}
		</div>
	{/if}
{/snippet}

<DetailScreen
	title="Memory change"
	{back}
	{banner}
	footer={write ? footer : undefined}
	toast={result ? toast : undefined}
	state={{
		remote: write === null ? { status: 'ready' } : remote,
		isEmpty: write === null,
		empty: {
			title: 'No such change',
			body: 'It may have been tidied away. Memory lists every change that is still there.'
		},
		offline: !online,
		errorTitle: "Couldn't load this change.",
		onretry,
		skeleton
	}}
>
	{#if write}
		<article class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-4">
			<header class="flex flex-col gap-2">
				<a
					href={fileHref(write.fileId)}
					class="-my-3 flex min-h-12 items-center self-start font-mono text-meta [overflow-wrap:anywhere] text-muted-foreground hover:text-foreground"
					>{write.path}</a
				>
				<h2 class="text-lg leading-snug font-semibold text-balance">{write.summary}</h2>
				<p class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
					<span class="tabular-nums">{ago(write.at, now)}</span>
					<span class="inline-flex items-center gap-1 font-mono text-meta">
						<GitCommitHorizontal class="size-3.5" aria-hidden="true" />{write.commit}
					</span>
					{#if write.taint}<StatePill of="tainted" label={write.taint} />{/if}
					{#if write.reverted}<StatePill of="archived" label="Reverted" />{/if}
				</p>
			</header>

			<DiffView lines={write.diff} file={write.path} />

			{#if write.reverted}
				<p class="text-sm text-muted-foreground">
					Reverted {ago(write.reverted.at, now)} in
					<span class="font-mono text-meta">{write.reverted.commit}</span>. The agent doesn't see
					these lines any more.
				</p>
			{/if}

			<section class="flex flex-col gap-1">
				<h3 class="text-sm font-medium text-muted-foreground">Written by</h3>
				{#if write.run}
					<a
						href={runHref(write.run.id)}
						class="-my-1 flex min-h-12 items-center gap-1 self-start text-sm font-medium hover:underline"
						>{write.run.title}<ArrowUpRight class="size-3.5 shrink-0" aria-hidden="true" /></a
					>
				{/if}
				{#if write.thread}
					<a
						href={threadHref(write.thread.id)}
						class="-my-1 flex min-h-12 items-center gap-1 self-start text-sm font-medium hover:underline"
						>Thread · {write.thread.title}<ArrowUpRight
							class="size-3.5 shrink-0"
							aria-hidden="true"
						/></a
					>
				{/if}
				{#if write.taint}
					<p class="text-sm text-muted-foreground">
						That run had read content from outside before it wrote this. Check it before the agent
						relies on it.
					</p>
				{/if}
			</section>
		</article>
	{/if}
</DetailScreen>
