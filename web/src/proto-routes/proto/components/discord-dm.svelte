<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import CirclePlus from '@lucide/svelte/icons/circle-plus';

	type Line = { from: 'you' | 'bot'; text: string; time: string };
	let { lines }: { lines: Line[] } = $props();
</script>

<!-- A Discord DM, drawn only to show what the retired surface says. -->
<div
	class="flex h-full flex-col bg-[oklch(0.25_0.01_270)] pt-[47px] text-[oklch(0.93_0.005_270)]"
	aria-label="Discord direct message"
>
	<div class="flex items-center gap-2 border-b border-white/10 px-3 py-3">
		<ChevronLeft class="size-6 text-white/70" aria-hidden="true" />
		<span
			class="grid size-8 place-items-center rounded-full bg-[oklch(0.55_0.2_275)] text-sm font-bold text-white"
			>s</span
		>
		<span class="font-semibold">sushii-agent</span>
		<span class="rounded bg-[oklch(0.55_0.2_275)] px-1 text-[10px] font-semibold text-white"
			>APP</span
		>
	</div>
	<ol class="mt-auto flex flex-col gap-4 px-3 py-4">
		{#each lines as line, i (i)}
			<li class="flex gap-3">
				<span
					class="grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white {line.from ===
					'bot'
						? 'bg-[oklch(0.55_0.2_275)]'
						: 'bg-[oklch(0.6_0.12_160)]'}">{line.from === 'bot' ? 's' : 'S'}</span
				>
				<span class="flex min-w-0 flex-col">
					<span class="flex items-baseline gap-2">
						<span class="font-semibold">{line.from === 'bot' ? 'sushii-agent' : 'Sam'}</span>
						<span class="text-xs text-white/50">{line.time}</span>
					</span>
					<span class="text-[15px] leading-snug [overflow-wrap:anywhere]">{line.text}</span>
				</span>
			</li>
		{/each}
	</ol>
	<div class="flex items-center gap-2 px-3 pt-1 pb-[42px]">
		<CirclePlus class="size-7 text-white/60" aria-hidden="true" />
		<span class="flex-1 rounded-full bg-[oklch(0.2_0.01_270)] px-4 py-2.5 text-[15px] text-white/45"
			>Message @sushii-agent</span
		>
	</div>
</div>
