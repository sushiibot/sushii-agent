<script lang="ts">
	import Archive from '@lucide/svelte/icons/archive';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { SkillDetail } from './types';

	let {
		remote,
		skill,
		now,
		back,
		online = true,
		busy = false,
		error = null,
		runHref = (id) => `/runs/${id}`,
		versionsHref = (name) => `/skills/${name}/versions`,
		onsetstage,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no such skill. */
		skill?: SkillDetail | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		busy?: boolean;
		error?: string | null;
		runHref?: (id: string) => string;
		versionsHref?: (name: string) => string;
		onsetstage?: (stage: 'active' | 'archived') => void;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();
	const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-6 w-1/2" />
		<Skeleton class="h-16 w-full rounded-xl" />
		<Skeleton class="h-4 w-4/5" />
	</div>
	<p role="status" class="sr-only">Loading the skill…</p>
{/snippet}

{#snippet footer()}
	{#if skill && skill.stage !== 'archived'}
		<div class="flex flex-col gap-2 border-t px-4 py-3">
			{#if error}<p role="alert" class="text-sm text-failed">Couldn't change it. {error}</p>{/if}
			<div class="flex gap-2">
				<Button
					size="lg"
					variant="outline"
					class="flex-1"
					disabled={busy || !online}
					onclick={() => onsetstage?.('archived')}><Archive />Archive</Button
				>
				{#if skill.stage === 'draft' || skill.stage === 'stale'}
					<Button
						size="lg"
						class="flex-1"
						disabled={busy || !online}
						onclick={() => onsetstage?.('active')}
					>
						{#if busy}<LoaderCircle
								class="animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>Saving…{:else}{skill.stage === 'draft' ? 'Use it now' : 'Mark in use'}{/if}
					</Button>
				{/if}
			</div>
		</div>
	{/if}
{/snippet}

<DetailScreen
	title="Skill"
	{back}
	{banner}
	footer={skill ? footer : undefined}
	state={{
		remote: skill === null ? { status: 'ready' } : remote,
		isEmpty: skill === null,
		empty: { title: 'No such skill', body: 'It may have been merged into another skill.' },
		offline: !online,
		errorTitle: "Couldn't load this skill.",
		onretry,
		skeleton
	}}
>
	{#if skill}
		<article class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-4">
			<header class="flex flex-col gap-2">
				<div class="flex flex-wrap items-center gap-2">
					<h2 class="font-mono text-base font-semibold [overflow-wrap:anywhere]">{skill.name}</h2>
					<StatePill of={skill.stage} />
				</div>
				<p class="text-sm text-muted-foreground">{skill.description}</p>
			</header>

			<dl class="grid grid-cols-3 divide-x rounded-xl border text-sm">
				{#each [['Loaded', `${skill.uses} runs`], ['Verified', pct(skill.successRate)], ['Last used', skill.lastUsed ? ago(skill.lastUsed, now) : 'Never']] as [k, v] (k)}
					<div class="flex min-w-0 flex-col px-3 py-2">
						<dt class="text-meta text-muted-foreground">{k}</dt>
						<dd class="font-medium [overflow-wrap:anywhere] tabular-nums">{v}</dd>
					</div>
				{/each}
			</dl>

			<section class="flex flex-col gap-1.5">
				<h3 class="text-sm font-semibold">
					Why it's {skill.stage === 'active' ? 'in use' : skill.stage}
				</h3>
				<p class="text-sm">{skill.why}</p>
			</section>

			<a
				href={versionsHref(skill.name)}
				class="flex min-h-14 items-center gap-3 rounded-xl border px-3 py-2 hover:bg-muted/60"
			>
				<span class="flex flex-1 flex-col">
					<span class="text-ui font-medium">Versions and SKILL.md</span>
					<span class="text-meta text-muted-foreground"
						>Version {skill.version}, {skill.versions.length}
						{skill.versions.length === 1 ? 'change' : 'changes'} with diffs</span
					>
				</span>
				<ChevronRight class="size-4 text-muted-foreground" aria-hidden="true" />
			</a>

			<section aria-labelledby="{uid}-life" class="flex flex-col gap-2">
				<h3 id="{uid}-life" class="text-sm font-semibold">Lifecycle</h3>
				<ol class="flex flex-col gap-3 border-l pl-4">
					{#each skill.history as h (h.at + h.event)}
						<li class="relative text-sm">
							<span
								class="absolute top-1.5 -left-5.25 size-2 rounded-full bg-foreground/40"
								aria-hidden="true"
							></span>
							<span class="font-medium">{h.event}</span>
							<span class="text-muted-foreground"> · {ago(h.at, now)}</span>
							<p class="text-muted-foreground">{h.reason}</p>
						</li>
					{/each}
				</ol>
			</section>

			{#if skill.runs.length}
				<section aria-labelledby="{uid}-runs" class="flex flex-col gap-2">
					<h3 id="{uid}-runs" class="text-sm font-semibold">Runs that loaded it</h3>
					<ul class="flex flex-col divide-y rounded-xl border text-sm">
						{#each skill.runs as r (r.id)}
							<li>
								<a
									href={runHref(r.id)}
									class="flex min-h-12 items-center gap-2 px-3 py-2 hover:bg-muted/60"
								>
									{#if r.ok}
										<CircleCheck class="size-4 shrink-0 text-review" aria-hidden="true" />
										<span class="sr-only">Verified:</span>
									{:else}
										<CircleX class="size-4 shrink-0 text-failed" aria-hidden="true" />
										<span class="sr-only">Failed:</span>
									{/if}
									<span class="flex-1">{r.title}</span>
									<span class="text-meta text-muted-foreground">{ago(r.at, now)}</span>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</article>
	{/if}
</DetailScreen>
