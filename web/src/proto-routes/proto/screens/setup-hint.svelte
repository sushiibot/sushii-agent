<script lang="ts">
	import Share from '@lucide/svelte/icons/share';
	import SquarePlus from '@lucide/svelte/icons/square-plus';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import BellOff from '@lucide/svelte/icons/bell-off';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import type { PushState } from './types';

	let { kind, push = 'default' }: { kind: 'install' | 'push' | 'push-off'; push?: PushState } =
		$props();
	const dismissible = $derived(kind === 'install');
</script>

<aside
	aria-label={kind === 'install' ? 'Install the app' : 'Notifications'}
	class={cn(
		'relative flex items-start gap-3 rounded-xl border bg-card p-3 text-sm',
		dismissible && 'pr-12',
		kind === 'push-off' && 'border-waiting/40 bg-waiting-soft/50'
	)}
>
	<span
		class={cn(
			'grid size-8 shrink-0 place-items-center rounded-lg',
			kind === 'push-off' ? 'bg-waiting-soft text-waiting' : 'bg-brand/12 text-brand'
		)}
	>
		{#if kind === 'install'}<SquarePlus
				class="size-4"
				aria-hidden="true"
			/>{:else if kind === 'push-off' || push === 'denied'}<BellOff
				class="size-4"
				aria-hidden="true"
			/>{:else}<BellRing class="size-4" aria-hidden="true" />{/if}
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
	{:else if kind === 'push-off'}
		<div class="flex min-w-0 flex-1 flex-col items-start gap-2">
			<p class="font-medium">Approvals can wait unseen. Turn on notifications.</p>
			<Button variant="outline" href="/more">Notification settings</Button>
		</div>
	{:else if push === 'denied'}
		<div class="flex min-w-0 flex-col gap-1.5">
			<p class="font-medium">Notifications are blocked in your browser settings</p>
			<ol class="flex list-decimal flex-col gap-1 pl-4 text-muted-foreground">
				<li>Long-press the Agent icon on your home screen and tap <b>App info</b>.</li>
				<li>Tap <b>Notifications</b> and turn on <b>Allow notifications</b>.</li>
				<li>Come back here. This hint clears on its own.</li>
			</ol>
		</div>
	{:else if push === 'unsupported'}
		<p class="flex flex-col gap-0.5">
			<span class="font-medium">This browser can't show notifications</span>
			<span class="text-muted-foreground"
				>Install the app from Chrome on Android to get approvals and questions as notifications.</span
			>
		</p>
	{:else}
		<div class="flex flex-col items-start gap-2">
			<p class="flex flex-col gap-0.5">
				<span class="font-medium">Get notified when the agent needs you</span>
				<span class="text-muted-foreground">
					You'll get a notification when the agent needs your approval or asks you something, when a
					task fails, and when a reply finishes while you're away.
				</span>
			</p>
			<Button>Enable notifications</Button>
		</div>
	{/if}
	{#if dismissible}
		<Button variant="ghost" class="absolute top-0 right-0 size-12 px-0" aria-label="Dismiss"
			><X /></Button
		>
	{/if}
</aside>
