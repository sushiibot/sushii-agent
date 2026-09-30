<script lang="ts">
	import ArrowBigUp from '@lucide/svelte/icons/arrow-big-up';
	import Delete from '@lucide/svelte/icons/delete';
	import Smile from '@lucide/svelte/icons/smile';
	import Mic from '@lucide/svelte/icons/mic';

	let { height, suggestions = [] }: { height: number; suggestions?: string[] } = $props();
	const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
	const key =
		'grid h-[42px] place-items-center rounded-[6px] bg-white text-[21px] shadow-[0_1px_0_rgb(0_0_0/0.28)] dark:bg-[oklch(0.44_0_0)] dark:text-white';
	const fn =
		'grid h-[42px] place-items-center rounded-[6px] bg-[oklch(0.74_0.008_260)] text-[15px] shadow-[0_1px_0_rgb(0_0_0/0.28)] dark:bg-[oklch(0.33_0_0)] dark:text-white';
</script>

<div
	class="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-[11px] bg-[oklch(0.86_0.006_260)] px-[3px] pt-1 text-black dark:bg-[oklch(0.24_0_0)]"
	style="height: {height}px"
	aria-hidden="true"
>
	<div class="grid h-10 grid-cols-3 items-center text-center text-[15px] dark:text-white">
		{#each suggestions as s, i (i)}<span class={i === 1 ? 'font-medium' : ''}>{s}</span>{/each}
	</div>
	{#each rows as row, r (row)}
		<div class="flex gap-[6px] {r === 1 ? 'px-[18px]' : ''}">
			{#if r === 2}<span class="{fn} w-[42px] shrink-0"><ArrowBigUp class="size-5" /></span>{/if}
			{#each row as ch (ch)}<span class="{key} flex-1">{ch}</span>{/each}
			{#if r === 2}<span class="{fn} w-[42px] shrink-0"><Delete class="size-5" /></span>{/if}
		</div>
	{/each}
	<div class="flex gap-[6px]">
		<span class="{fn} w-[88px] shrink-0">123</span>
		<span class="{key} flex-1 text-[15px]">space</span>
		<span class="{fn} w-[88px] shrink-0">return</span>
	</div>
	<div class="flex justify-between px-6 text-[oklch(0.45_0_0)] dark:text-white/80">
		<Smile class="size-6" /><Mic class="size-6" />
	</div>
</div>
