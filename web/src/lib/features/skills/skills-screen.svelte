<script lang="ts">
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import ListScreen, { type ListSection } from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import SkillRow from './components/skill-row.svelte';
	import type { SkillStage, SkillSummary } from './types';

	let {
		remote,
		skills,
		now,
		back,
		online = true,
		skillHref = (name) => `/skills/${name}`,
		onretry
	}: {
		remote: RemoteLike;
		skills: SkillSummary[];
		now: number;
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		skillHref?: (name: string) => string;
		onretry?: () => void;
	} = $props();

	const order: [SkillStage, string][] = [
		['active', 'In use'],
		['draft', 'Drafts'],
		['stale', 'Stale'],
		['archived', 'Archived']
	];
	const sections = $derived(
		order.map(([stage, label]): ListSection<SkillSummary> => ({
			label,
			count: true,
			items: skills.filter((s) => s.stage === stage)
		}))
	);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [0, 1, 2] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-4 w-1/2" />
				<Skeleton class="h-3 w-4/5" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading skills…</p>
{/snippet}

{#snippet lead()}
	<p class="px-1 text-sm text-muted-foreground">
		How-tos the agent wrote for itself. A draft loads on its own only after three verified runs.
	</p>
{/snippet}

{#snippet row(s: SkillSummary)}
	<SkillRow skill={s} {now} href={skillHref(s.name)} />
{/snippet}

<ListScreen
	title="Skills"
	{back}
	{banner}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load skills.",
		onretry,
		skeleton,
		empty: {
			title: 'No skills yet',
			body: 'When the agent works out how to do something it will do again, it drafts a skill here.'
		}
	}}
	{sections}
	key={(s) => s.name}
	{lead}
	{row}
/>
