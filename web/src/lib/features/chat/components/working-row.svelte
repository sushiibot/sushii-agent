<script lang="ts">
	import CircleStop from '@lucide/svelte/icons/circle-stop';
	import ToolRow from './tool-row.svelte';
	import ToolActivityGroup from './tool-activity-group.svelte';
	import { groupToolActivity } from '../tool-activity';
	import type { Turn } from '../types';
	const phrases = [
		{ emoji: '🍣', text: 'Rolling sushi…' },
		{ emoji: '🐾', text: 'Chasing a thought…' },
		{ emoji: '🍚', text: 'Steaming rice…' },
		{ emoji: '🐱', text: 'Kneading ideas…' },
		{ emoji: '🍲', text: 'Boiling broth…' },
		{ emoji: '🍜', text: 'Simmering ramen…' },
		{ emoji: '🐈', text: 'Following a hunch…' },
		{ emoji: '🔪', text: 'Slicing sashimi…' },
		{ emoji: '🥟', text: 'Folding gyoza…' },
		{ emoji: '🍙', text: 'Shaping onigiri…' },
		{ emoji: '🐈‍⬛', text: 'Hunting for clues…' },
		{ emoji: '🥢', text: 'Plating nigiri…' },
		{ emoji: '🍤', text: 'Frying tempura…' },
		{ emoji: '🍵', text: 'Whisking matcha…' },
		{ emoji: '🫖', text: 'Brewing tea…' }
	];
	let { turn, openStep }: { turn: Turn; open?: boolean; openStep?: string } = $props();
	const busy = $derived(
		turn.state === 'working' || turn.state === 'thinking' || turn.state === 'stopping'
	);
	const status = $derived(turn.state === 'stopping' ? 'Stopping…' : (turn.label ?? 'Working…'));
	const toolRunning = $derived(
		turn.toolRunning || turn.steps.some((step) => step.state === 'running')
	);
	// The active tool already provides progress; retain stopping and specific turn states.
	const showStatus = $derived(
		busy && (!toolRunning || turn.state === 'stopping' || (turn.label && turn.label !== 'Working…'))
	);
	const themed = $derived(showStatus && status === 'Thinking…');
	let phase = $state(0);
	let reducedMotion = $state(true);
	const phrase = $derived(phrases[phase]);
	$effect(() => {
		const media = matchMedia('(prefers-reduced-motion: reduce)');
		const update = () => {
			reducedMotion = media.matches;
		};
		update();
		media.addEventListener('change', update);
		return () => media.removeEventListener('change', update);
	});
	$effect(() => {
		if (themed) phase = Math.floor(Math.random() * phrases.length);
	});
	$effect(() => {
		if (!themed || reducedMotion) return;
		const timer = setInterval(() => {
			// Media change events can lag the CSS preference; honor the current value at the tick too.
			if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches)
				phase = (phase + 1) % phrases.length;
		}, 8000);
		return () => clearInterval(timer);
	});
</script>

{#each groupToolActivity(turn.steps.map( (step) => ({ type: 'data-tool' as const, data: step }) )) as { part, index } (index)}
	{#if part.type === 'data-tool-group'}<ToolActivityGroup steps={part.data} {openStep} />
	{:else if part.type === 'data-tool'}<ToolRow
			step={part.data}
			open={openStep === part.data.id}
		/>{/if}
{/each}
{#if showStatus}
	<p
		role="status"
		data-typing
		class="flex min-h-6 items-center gap-2 py-1 text-meta text-muted-foreground"
	>
		<span aria-hidden="true" class="flex items-center gap-1.5">
			{#if themed}<span data-thinking-emoji>{phrase.emoji}</span>{/if}
			<span class="typing-status">{themed ? phrase.text : status}</span>
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
