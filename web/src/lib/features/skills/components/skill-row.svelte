<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { ago } from '$lib/ui/format/time';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { SkillSummary } from '../types';

	let { skill, now, href }: { skill: SkillSummary; now: number; href: string } = $props();
</script>

<a
	{href}
	class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
>
	<span class="flex min-w-0 flex-1 flex-col gap-1">
		<span class="flex flex-wrap items-center gap-2">
			<span class="font-mono text-ui font-medium [overflow-wrap:anywhere]">{skill.name}</span>
			<StatePill of={skill.stage} />
		</span>
		<span class="text-sm text-muted-foreground">{skill.description}</span>
		<span class="text-meta text-muted-foreground tabular-nums"
			>v{skill.version} · {skill.uses}
			{skill.uses === 1 ? 'run' : 'runs'}{#if skill.lastUsed}
				· last {ago(skill.lastUsed, now)}{/if}</span
		>
	</span>
	<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
</a>
