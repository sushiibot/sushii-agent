<script lang="ts">
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Settings from '@lucide/svelte/icons/settings';
	import { resolve } from '$app/paths';
	import AppShell from '$lib/agent/app-shell.svelte';
	import { Textarea } from '$lib/components/ui/textarea';
	import ConnectionBanner from '$lib/app/connection-banner.svelte';
	import InstallHint from '$lib/app/install-hint.svelte';
	import UpdateToast from '$lib/app/update-toast.svelte';
	import { pwa } from '$lib/app/pwa.svelte';
</script>

<svelte:head><title>Agent</title></svelte:head>

{#snippet subtitle()}
	<span class="text-xs text-muted-foreground">Your agent</span>
{/snippet}

{#snippet actions()}
	<a
		href={resolve('/settings')}
		aria-label="Settings"
		class="grid size-12 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
	>
		<Settings class="size-5" aria-hidden="true" />
	</a>
{/snippet}

{#snippet banner()}<ConnectionBanner />{/snippet}

{#snippet toast()}<UpdateToast />{/snippet}

{#snippet footer()}
	<form class="px-3 py-2.5" onsubmit={(e) => e.preventDefault()}>
		<label for="composer" class="sr-only">Message</label>
		<div class="flex items-end gap-2 rounded-3xl border bg-card p-1 pl-2">
			<Textarea
				id="composer"
				rows={1}
				disabled
				placeholder="Message your agent"
				class="min-h-12 resize-none border-0 bg-transparent py-3 text-base shadow-none focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent"
			/>
			<button
				type="submit"
				disabled
				aria-label="Send message"
				class="grid size-12 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
			>
				<ArrowUp class="size-5" aria-hidden="true" />
			</button>
		</div>
	</form>
{/snippet}

<AppShell
	active="home"
	title="Main"
	{subtitle}
	{actions}
	{banner}
	{footer}
	toast={pwa.waiting ? toast : undefined}
	tabBar={false}
>
	<div class="mx-auto flex h-full max-w-2xl flex-col gap-6 px-4 py-6">
		<InstallHint />
		<div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<span
				class="grid size-14 place-items-center rounded-2xl bg-foreground text-background"
				aria-hidden="true"
			>
				<svg viewBox="0 0 16 16" class="size-7"
					><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" /><circle
						cx="8"
						cy="8"
						r="1.6"
						fill="currentColor"
					/></svg
				>
			</span>
			<p class="flex max-w-72 flex-col gap-1">
				<span class="text-lg font-semibold text-balance">Say hi to your agent.</span>
				<span class="text-sm text-muted-foreground">Chat arrives in the next update.</span>
			</p>
		</div>
	</div>
</AppShell>
