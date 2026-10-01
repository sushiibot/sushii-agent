<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import UpdateToast from '$lib/ui/pwa/update-toast.svelte';
	import ListScreen from '$lib/ui/screen/list-screen.svelte';
	import type { NavItem } from '$lib/ui/shell/types';

	let {
		entries,
		online = true,
		updateReady = false,
		onreload
	}: {
		entries: NavItem[];
		online?: boolean;
		updateReady?: boolean;
		onreload?: () => void;
	} = $props();
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}
{#snippet toast()}<UpdateToast onreload={() => onreload?.()} />{/snippet}

{#snippet row(entry: NavItem)}
	<a
		href={entry.href}
		class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
	>
		<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
			<entry.icon class="size-5" aria-hidden="true" />
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span class="text-ui font-medium">{entry.label}</span>
			<span class="text-sm text-muted-foreground">{entry.description}</span>
		</span>
		<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	</a>
{/snippet}

<ListScreen
	title="More"
	{banner}
	toast={updateReady ? toast : undefined}
	state={{ remote: { status: 'ready' } }}
	sections={[{ items: entries }]}
	key={(e) => e.id}
	{row}
/>
