<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ToolIcon from './tool-icon.svelte';
	import ToolRow from './tool-row.svelte';
	import { activityCategories } from '../tool-activity';
	import type { TurnStep } from '../types';
	let { steps, openStep }: { steps: TurnStep[]; openStep?: string } = $props();
	const categories = $derived(activityCategories(steps));
	const running = $derived(steps.some((step) => step.state === 'running'));
	const label = $derived(
		`${steps.length} tool calls: ${categories.map((c) => `${c.label} × ${c.count}`).join(', ')}${running ? ', running' : ''}`
	);
</script>

<details
	open={steps.some((step) => step.id === openStep)}
	data-tool-activity
	class="group/activity min-w-0 text-ui text-muted-foreground"
>
	<summary
		aria-label={label}
		class="flex min-h-12 cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden"
	>
		<span class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
			{#each categories.slice(0, 2) as category (category.key)}
				<span class="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
					><ToolIcon kind={category.kind} /><span class="truncate"
						>{category.label} × {category.count}</span
					></span
				>
			{/each}
			{#if categories.length > 2}<span class="shrink-0 text-meta">+{categories.length - 2}</span
				>{/if}
		</span>
		{#if running}<span class="flex shrink-0 items-center gap-1 text-meta text-running"
				><LoaderCircle
					class="size-3.5 animate-spin motion-reduce:animate-none"
					aria-hidden="true"
				/><span>Running</span></span
			>{/if}
		<ChevronDown
			class="size-3.5 shrink-0 transition-transform group-open/activity:rotate-180 motion-reduce:transition-none"
			aria-hidden="true"
		/>
	</summary>
	<ul class="min-w-0 border-l pl-3">
		{#each steps as step, index (`${index}:${step.id}`)}<li>
				<ToolRow {step} open={openStep === step.id} />
			</li>{/each}
	</ul>
</details>
