<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { Markdown } from '$lib/features/chat';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import DiffView from '$lib/ui/diff/diff-view.svelte';
	import { ago } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import type { SkillDetail } from './types';

	let {
		remote,
		skill,
		now,
		back,
		online = true,
		open = [],
		runHref = (id) => `/runs/${id}`,
		onretry
	}: {
		remote: RemoteLike;
		skill?: SkillDetail | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		/** Versions whose diff starts open; the newest is open by default. */
		open?: number[];
		runHref?: (id: string) => string;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-24 w-full rounded-xl" />
		<Skeleton class="h-12 w-full rounded-xl" />
	</div>
	<p role="status" class="sr-only">Loading versions…</p>
{/snippet}

<DetailScreen
	title={skill ? `${skill.name} versions` : 'Versions'}
	{back}
	{banner}
	state={{
		remote: skill === null ? { status: 'ready' } : remote,
		isEmpty: skill === null,
		empty: { title: 'No such skill', body: 'It may have been merged into another skill.' },
		offline: !online,
		errorTitle: "Couldn't load the versions.",
		onretry,
		skeleton
	}}
>
	{#if skill}
		<div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-4">
			<section aria-labelledby="{uid}-now" class="flex flex-col gap-2">
				<h2 id="{uid}-now" class="text-sm font-semibold">SKILL.md now, version {skill.version}</h2>
				<div class="rounded-xl border bg-card px-4 py-3 text-body">
					<Markdown text={skill.content} />
				</div>
			</section>
			<section aria-labelledby="{uid}-hist" class="flex flex-col gap-2">
				<h2 id="{uid}-hist" class="text-sm font-semibold">History</h2>
				{#if skill.versions.length}
					<ol class="flex flex-col gap-2">
						{#each skill.versions as v, i (v.version)}
							<li>
								<details
									class="group rounded-xl border"
									open={open.length ? open.includes(v.version) : i === 0}
								>
									<summary
										class="flex min-h-14 cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden"
									>
										<span class="flex flex-1 flex-col">
											<span class="text-ui font-medium">Version {v.version}</span>
											<span class="text-meta text-muted-foreground"
												>{ago(v.at, now)} · {v.reason}</span
											>
										</span>
										<ChevronDown
											class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
											aria-hidden="true"
										/>
									</summary>
									<div class="flex flex-col gap-2 px-3 pb-3">
										<DiffView lines={v.diff} file="SKILL.md" />
										{#if v.run}
											<a
												href={runHref(v.run.id)}
												class="-my-1 flex min-h-12 items-center gap-1 self-start text-sm font-medium hover:underline"
												>Written during {v.run.title}<ArrowUpRight
													class="size-3.5"
													aria-hidden="true"
												/></a
											>
										{/if}
									</div>
								</details>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-sm text-muted-foreground">No saved versions.</p>
				{/if}
			</section>
		</div>
	{/if}
</DetailScreen>
