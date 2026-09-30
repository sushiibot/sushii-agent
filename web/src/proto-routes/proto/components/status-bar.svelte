<script lang="ts">
	import Signal from '@lucide/svelte/icons/signal';
	import Wifi from '@lucide/svelte/icons/wifi';
	import BatteryFull from '@lucide/svelte/icons/battery-full';

	let { light = false }: { light?: boolean } = $props();
</script>

<div
	class="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-[47px] items-center justify-between px-7 pt-1 text-[15px] font-semibold tabular-nums {light
		? 'text-white'
		: 'text-foreground'}"
	aria-hidden="true"
>
	<span class="w-16">9:41</span>
	<span
		class="absolute top-[11px] left-1/2 h-[30px] w-[108px] -translate-x-1/2 rounded-full bg-black"
	></span>
	<span class="flex w-16 items-center justify-end gap-1">
		<Signal class="size-4" strokeWidth={2.5} />
		<Wifi class="size-4" strokeWidth={2.5} />
		<BatteryFull class="size-5" strokeWidth={2} />
	</span>
</div>
