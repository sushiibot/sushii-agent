<script lang="ts">
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import Camera from '@lucide/svelte/icons/camera';
	import Image from '@lucide/svelte/icons/image';
	import Mail from '@lucide/svelte/icons/mail';
	import Map from '@lucide/svelte/icons/map';
	import Music from '@lucide/svelte/icons/music';
	import NotebookPen from '@lucide/svelte/icons/notebook-pen';
	import Settings from '@lucide/svelte/icons/settings';
	import Phone from '@lucide/svelte/icons/phone';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import Compass from '@lucide/svelte/icons/compass';
	import CloudSun from '@lucide/svelte/icons/cloud-sun';
	import Clock from '@lucide/svelte/icons/clock';

	const apps = [
		{ label: 'Calendar', icon: CalendarDays, bg: 'bg-white text-red-500' },
		{ label: 'Photos', icon: Image, bg: 'bg-white text-amber-500' },
		{ label: 'Camera', icon: Camera, bg: 'bg-zinc-300 text-zinc-800' },
		{ label: 'Mail', icon: Mail, bg: 'bg-sky-500 text-white' },
		{ label: 'Weather', icon: CloudSun, bg: 'bg-sky-400 text-white' },
		{ label: 'Clock', icon: Clock, bg: 'bg-black text-white' },
		{ label: 'Maps', icon: Map, bg: 'bg-emerald-400 text-white' },
		{ label: 'Notes', icon: NotebookPen, bg: 'bg-yellow-300 text-amber-950' },
		{ label: 'Settings', icon: Settings, bg: 'bg-zinc-500 text-white' },
		{ label: 'Music', icon: Music, bg: 'bg-rose-500 text-white' }
	];
	const dock = [
		{ label: 'Phone', icon: Phone, bg: 'bg-green-500 text-white' },
		{ label: 'Browser', icon: Compass, bg: 'bg-white text-sky-500' },
		{ label: 'Messages', icon: MessageCircle, bg: 'bg-green-500 text-white' },
		{ label: 'Mail', icon: Mail, bg: 'bg-sky-500 text-white' }
	];
</script>

<div
	class="relative flex h-full flex-col bg-[linear-gradient(160deg,oklch(0.42_0.12_275),oklch(0.3_0.09_300)_55%,oklch(0.22_0.05_250))] px-5 pt-[70px] pb-6 text-white"
>
	<div class="grid grid-cols-4 gap-x-4 gap-y-5">
		{#each apps as app (app.label)}
			<span class="flex flex-col items-center gap-1.5" aria-hidden="true">
				<span class="grid aspect-square w-full place-items-center rounded-[22%] {app.bg}">
					<app.icon class="size-[45%]" />
				</span>
				<span class="text-[11px]">{app.label}</span>
			</span>
		{/each}
		<button type="button" class="flex flex-col items-center gap-1.5">
			<span
				class="relative grid aspect-square w-full place-items-center rounded-[22%] bg-[oklch(0.145_0_0)] ring-2 ring-white/70 ring-offset-4 ring-offset-transparent"
			>
				<svg viewBox="0 0 16 16" class="size-[48%] text-white" aria-hidden="true"
					><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" /><circle
						cx="8"
						cy="8"
						r="1.6"
						fill="currentColor"
					/></svg
				>
			</span>
			<span class="text-[11px] font-medium">Agent</span>
		</button>
	</div>
	<p class="mt-8 self-center rounded-full bg-white/15 px-3 py-1.5 text-xs backdrop-blur-sm">
		Opens full screen, no browser bars
	</p>
	<div class="mt-auto grid grid-cols-4 gap-4 rounded-[32px] bg-white/20 p-3 backdrop-blur-md">
		{#each dock as app (app.label)}
			<span class="grid aspect-square place-items-center rounded-[22%] {app.bg}" aria-hidden="true">
				<app.icon class="size-[45%]" />
			</span>
		{/each}
	</div>
</div>
