<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import AppShell from '$lib/ui/shell/app-shell.svelte';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import MemoryTabs from './memory-tabs.svelte';
	import type { Skill } from './types';

	let { skills, selected }: { skills: Skill[]; selected?: string } = $props();
	const skill = $derived(skills.find((s) => s.name === selected));
	const pct = (n: number) => `${Math.round(n * 100)}%`;
</script>

{#snippet detail(s: Skill)}
	<article class="flex flex-col gap-5">
		<header class="flex flex-col gap-2">
			<div class="flex flex-wrap items-center gap-2">
				<h2 class="font-mono text-base font-semibold">{s.name}</h2>
				<StatePill of={s.stage} />
			</div>
			<p class="text-sm text-muted-foreground">{s.description}</p>
		</header>

		<dl class="grid grid-cols-3 divide-x rounded-lg border text-sm">
			{#each [['Loaded', `${s.uses} runs`], ['Succeeded', pct(s.successRate)], ['Last used', s.lastUsed]] as [k, v] (k)}
				<div class="flex flex-col px-3 py-2">
					<dt class="text-xs text-muted-foreground">{k}</dt>
					<dd class="font-medium tabular-nums">{v}</dd>
				</div>
			{/each}
		</dl>

		<section class="flex flex-col gap-1.5">
			<h3 class="text-sm font-semibold">Why it's {s.stage}</h3>
			<p class="text-sm">{s.reason}</p>
		</section>

		<section class="flex flex-col gap-2">
			<h3 class="text-sm font-semibold">Lifecycle</h3>
			<ol class="flex flex-col gap-3 border-l pl-4">
				{#each s.history as h (h.when + h.event)}
					<li class="relative text-sm">
						<span
							class="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-foreground/40"
							aria-hidden="true"
						></span>
						<span class="font-medium">{h.event}</span>
						<span class="text-muted-foreground"> · {h.when}</span>
						<p class="text-muted-foreground">{h.reason}</p>
					</li>
				{/each}
			</ol>
		</section>

		{#if s.runs.length}
			<section class="flex flex-col gap-2">
				<h3 class="text-sm font-semibold">Runs that loaded it</h3>
				<ul class="flex flex-col divide-y rounded-lg border text-sm">
					{#each s.runs as r (r.id)}
						<li>
							<a href="/runs/{r.id}" class="flex items-center gap-2 px-3 py-2 hover:bg-muted/60">
								{#if r.ok}
									<CircleCheck class="size-4 text-review" aria-label="Succeeded" />
								{:else}
									<CircleX class="size-4 text-failed" aria-label="Failed" />
								{/if}
								<span class="flex-1">{r.title}</span>
								<span class="text-xs text-muted-foreground">{r.when}</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<div class="flex flex-wrap gap-2">
			{#if s.stage === 'draft' || s.stage === 'stale'}
				<Button size="lg">{s.stage === 'draft' ? 'Promote now' : 'Mark active'}</Button>
			{/if}
			{#if s.stage !== 'archived'}
				<Button size="lg" variant="outline">Archive</Button>
			{/if}
			<Button size="lg" variant="ghost" href="/memory/skills/{s.name}/SKILL.md"
				>View SKILL.md</Button
			>
		</div>
	</article>
{/snippet}

<AppShell
	active="memory"
	title={skill ? 'Skill' : 'Skills'}
	back={skill ? { href: '/memory/skills', label: 'Skills' } : undefined}
	waiting={2}
>
	<div class="@3xl:grid @3xl:h-full @3xl:grid-cols-[minmax(0,22rem)_1fr]">
		<div
			class={cn(
				'flex flex-col gap-3 px-4 py-4 @3xl:overflow-y-auto @3xl:border-r',
				skill && 'hidden @3xl:flex'
			)}
		>
			<MemoryTabs active="skills" />
			<ul class="flex flex-col">
				{#each skills as s (s.name)}
					<li>
						<a
							href="/memory/skills/{s.name}"
							aria-current={s.name === selected ? 'true' : undefined}
							class={cn(
								'flex flex-col gap-1 rounded-md px-2 py-2.5 hover:bg-muted/60',
								s.name === selected && 'bg-muted'
							)}
						>
							<span class="flex items-center justify-between gap-2">
								<span class="truncate font-mono text-sm font-medium">{s.name}</span>
								<StatePill of={s.stage} />
							</span>
							<span class="text-xs text-muted-foreground tabular-nums"
								>{s.uses} runs · last {s.lastUsed}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		</div>
		<div
			class={cn(
				'px-4 py-4 @3xl:overflow-y-auto @3xl:px-8 @3xl:py-6',
				!skill && 'hidden @3xl:block'
			)}
		>
			{#if skill}
				{@render detail(skill)}
			{:else}
				<p class="text-sm text-muted-foreground">Pick a skill to see its lifecycle.</p>
			{/if}
		</div>
	</div>
</AppShell>
