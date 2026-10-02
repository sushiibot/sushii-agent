<script lang="ts">
	import CircleStop from '@lucide/svelte/icons/circle-stop';
	import ToolRow from './tool-row.svelte';
	import type { Turn } from '../types';
	let { turn, openStep }: { turn: Turn; open?: boolean; openStep?: string } = $props();
	const busy = $derived(
		turn.state === 'working' || turn.state === 'thinking' || turn.state === 'stopping'
	);
	const status = $derived(turn.state === 'stopping' ? 'Stopping…' : (turn.label ?? 'Working…'));
</script>

{#each turn.steps as step, i (`${i}:${step.id}`)}<ToolRow
		{step}
		open={openStep === step.id}
	/>{/each}
{#if busy}
	<p
		role="status"
		data-typing
		class="flex min-h-6 items-center gap-2 py-1 text-meta text-muted-foreground"
	>
		<span aria-hidden="true" class="flex items-center gap-1.5">
			<span class="typing-status">{status}</span>
		</span>
		<span class="sr-only">{status}</span>
	</p>
{:else if turn.state === 'stopped'}
	<p class="flex items-center gap-2 py-1 text-meta text-muted-foreground">
		<CircleStop class="size-4" aria-hidden="true" />{turn.label ?? 'Stopped by you'}
	</p>
{/if}

<style>
	@media (prefers-reduced-motion: no-preference) {
		.typing-status {
			background: linear-gradient(
				110deg,
				var(--muted-foreground) 35%,
				var(--foreground) 50%,
				var(--muted-foreground) 65%
			);
			background-size: 240% 100%;
			background-clip: text;
			color: transparent;
			animation: typing-shimmer 2.4s linear infinite;
		}
	}
	@keyframes typing-shimmer {
		from {
			background-position: 100% 0;
		}
		to {
			background-position: -100% 0;
		}
	}
</style>
