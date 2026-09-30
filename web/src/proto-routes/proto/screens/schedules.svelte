<script lang="ts">
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import { Button } from '$lib/ui/button';
	import { Switch } from '$lib/ui/switch';
	import { cn } from '$lib/utils';
	import AppShell from '$lib/ui/shell/app-shell.svelte';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { Job } from './types';

	let {
		jobs,
		selected,
		test = 'idle'
	}: { jobs: Job[]; selected?: string; test?: 'idle' | 'running' | 'done' } = $props();
	const job = $derived(jobs.find((j) => j.id === selected));
	const failing = $derived(jobs.filter((j) => j.last.result === 'failed'));
	// svelte-ignore state_referenced_locally
	let enabled = $state(Object.fromEntries(jobs.map((j) => [j.id, j.enabled])));
</script>

{#snippet detail(j: Job)}
	<article class="flex flex-col gap-5">
		<header class="flex items-start justify-between gap-4">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">{j.name}</h2>
				<p class="text-sm text-muted-foreground">{j.schedule} · next {j.next}</p>
			</div>
			<label class="flex items-center gap-2 text-sm">
				<Switch bind:checked={enabled[j.id]} aria-label="Enabled" />
				{enabled[j.id] ? 'On' : 'Paused'}
			</label>
		</header>

		<section class="flex flex-col gap-2 rounded-lg border p-3">
			<h3 class="text-sm font-semibold">Test run</h3>
			<p class="text-sm text-muted-foreground">
				Runs the job now with sending turned off. You see what it would have done.
			</p>
			{#if test === 'running'}
				<p class="flex items-center gap-2 text-sm text-running" role="status">
					<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
					Running the test… step 3 of about 6
				</p>
			{:else if test === 'done'}
				<div
					role="status"
					class="flex flex-col gap-1.5 rounded-md bg-review-soft px-3 py-2 text-sm text-review"
				>
					<StatePill of="verified" label="Test passed" class="self-start bg-background/60" />
					<p class="text-foreground/85">
						Would open a PR on notify-service with 5 minor updates. The registry token works again.
						Nothing was sent.
					</p>
				</div>
			{/if}
			<Button size="lg" variant="outline" class="self-start" disabled={test === 'running'}>
				<FlaskConical />{test === 'done' ? 'Test again' : 'Test run'}
			</Button>
		</section>

		<section class="flex flex-col gap-2">
			<h3 class="text-sm font-semibold">Recent runs</h3>
			<ol class="flex flex-col divide-y rounded-lg border text-sm">
				{#each j.history as h (h.when)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
						<span class="w-24 shrink-0 text-muted-foreground tabular-nums">{h.when}</span>
						<StatePill of={h.result} />
						<span class="min-w-0 flex-1 basis-40 text-muted-foreground">{h.note}</span>
					</li>
				{/each}
			</ol>
		</section>
	</article>
{/snippet}

<AppShell
	active="schedules"
	title={job ? 'Job' : 'Schedules'}
	back={job ? { href: '/schedules', label: 'Schedules' } : undefined}
	waiting={2}
>
	<div class="@3xl:grid @3xl:h-full @3xl:grid-cols-[minmax(0,26rem)_1fr]">
		<div
			class={cn(
				'flex flex-col gap-3 px-4 py-4 @3xl:overflow-y-auto @3xl:border-r',
				job && 'hidden @3xl:flex'
			)}
		>
			{#each failing as f (f.id)}
				<div
					role="alert"
					class="flex flex-col gap-2 rounded-lg bg-failed-soft p-3 text-sm text-failed"
				>
					<p class="flex items-center gap-2 font-semibold">
						<TriangleAlert class="size-4" aria-hidden="true" />{f.name} failed
					</p>
					<p class="text-foreground/85">
						{f.last.when}: {f.last.note}. It exited without an error, so only the missing PR showed
						it.
					</p>
					<div class="flex flex-wrap gap-2">
						<Button size="sm" variant="outline" class="bg-background" href="/runs/run-deps"
							>Open run<ArrowUpRight /></Button
						>
						<Button size="sm" variant="outline" class="bg-background" href="/schedules/{f.id}"
							>Fix and test</Button
						>
					</div>
				</div>
			{/each}
			<ul class="flex flex-col">
				{#each jobs as j (j.id)}
					<li>
						<a
							href="/schedules/{j.id}"
							aria-current={j.id === selected ? 'true' : undefined}
							class={cn(
								'flex flex-col gap-1.5 rounded-md px-2 py-2.5 hover:bg-muted/60',
								j.id === selected && 'bg-muted'
							)}
						>
							<span class="flex items-baseline justify-between gap-2">
								<span class="text-sm font-medium">{j.name}</span>
								<span class="shrink-0 text-xs text-muted-foreground"
									>{enabled[j.id] ? `next ${j.next}` : 'paused'}</span
								>
							</span>
							<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<StatePill of={j.last.result} />
								<span class="text-xs text-muted-foreground">{j.last.note}</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>
		</div>
		<div
			class={cn('px-4 py-4 @3xl:overflow-y-auto @3xl:px-8 @3xl:py-6', !job && 'hidden @3xl:block')}
		>
			{#if job}
				{@render detail(job)}
			{:else}
				<p class="text-sm text-muted-foreground">Pick a job to see its runs.</p>
			{/if}
		</div>
	</div>
</AppShell>
