<script lang="ts">
	import Share from '@lucide/svelte/icons/share';
	import SquarePlus from '@lucide/svelte/icons/square-plus';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	let { kind }: { kind: 'install' | 'push' } = $props();
</script>

<aside
	aria-label={kind === 'install' ? 'Install the app' : 'Notifications'}
	class="relative flex items-start gap-3 rounded-xl border bg-card p-3 pr-10 text-sm"
>
	<span class="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
		{#if kind === 'install'}<SquarePlus class="size-4" aria-hidden="true" />{:else}<BellRing
				class="size-4"
				aria-hidden="true"
			/>{/if}
	</span>
	{#if kind === 'install'}
		<p class="flex flex-col gap-0.5">
			<span class="font-medium">Install the app</span>
			<span class="text-muted-foreground">
				Tap <Share class="inline size-3.5 align-[-2px]" aria-label="Share" /> Share, then
				<span class="font-medium text-foreground">Add to Home Screen</span>. It opens full screen
				and can notify you.
			</span>
		</p>
	{:else}
		<div class="flex flex-col items-start gap-2">
			<p class="flex flex-col gap-0.5">
				<span class="font-medium">Get notified when something needs you</span>
				<span class="text-muted-foreground">Only approvals, questions and failures.</span>
			</p>
			<Button>Turn on notifications</Button>
		</div>
	{/if}
	<Button variant="ghost" size="icon-sm" class="absolute top-2 right-2" aria-label="Dismiss"
		><X /></Button
	>
</aside>
