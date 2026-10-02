<script lang="ts">
	import { Markdown } from '$lib/features/chat';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import WriteRow from './components/write-row.svelte';
	import type { MemoryFileDetail } from './types';

	let {
		remote,
		detail,
		now,
		back,
		online = true,
		writeHref = (id) => `/memory/writes/${id}`,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no such file. */
		detail?: MemoryFileDetail | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		writeHref?: (id: string) => string;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-3 w-1/3" />
		{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-4 w-full" />{/each}
	</div>
	<p role="status" class="sr-only">Loading the file…</p>
{/snippet}

<DetailScreen
	title={detail?.file.path ?? 'Memory file'}
	{back}
	{banner}
	state={{
		remote: detail === null ? { status: 'ready' } : remote,
		isEmpty: detail === null,
		empty: { title: 'No such file', body: 'The agent may have merged or removed it.' },
		offline: !online,
		errorTitle: "Couldn't load this file.",
		onretry,
		skeleton
	}}
>
	{#if detail}
		<div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-4">
			<p class="text-sm text-muted-foreground">
				{detail.file.about}. Changed {ago(detail.file.updatedAt, now)}.
			</p>
			{#if detail.file.truncated}<p role="status" class="text-sm text-muted-foreground">
					This file is large. Showing the first 256 KB.
				</p>{/if}
			<section
				aria-label="What the file says"
				class="rounded-xl border bg-card px-4 py-3 text-body"
			>
				<Markdown text={detail.file.content} />
			</section>
			{#if detail.writes.length}
				<section aria-labelledby="{uid}-w" class="flex flex-col gap-1">
					<h2 id="{uid}-w" class="px-1 text-sm font-medium text-muted-foreground">
						Changes to this file
					</h2>
					<ul class="flex flex-col">
						{#each detail.writes as w (w.id)}
							<li><WriteRow write={w} {now} href={writeHref(w.id)} /></li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	{/if}
</DetailScreen>
