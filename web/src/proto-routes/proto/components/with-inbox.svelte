<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ChatsScreen } from '$lib/features/threads';
	import { HomeScreen } from '$lib/features/home';
	import { busyGroups } from '$lib/features/home/fixtures';

	let props: ComponentProps<typeof ChatsScreen> = $props();
</script>

{#snippet inbox()}
	{@const groups = { ...busyGroups(props.now), waiting: [] }}
	{@const total = Object.values(groups).reduce((count, items) => count + items.length, 0)}
	<details aria-label="Inbox">
		<summary class="flex min-h-12 cursor-pointer items-center px-3 text-sm text-muted-foreground"
			>Inbox · {total}</summary
		>
		<HomeScreen embedded hideSheet {groups} remote={{ status: 'ready' }} now={props.now} />
	</details>
{/snippet}

{#snippet attention()}
	<section aria-label="Needs you" class="flex flex-col gap-2">
		<h2 class="px-1 text-base font-semibold">Needs you</h2>
		<HomeScreen
			embedded
			hideSheet
			compact
			groups={{ waiting: busyGroups(props.now).waiting, failed: [], running: [], review: [] }}
			remote={{ status: 'ready' }}
			now={props.now}
			itemContext={() => 'Main chat'}
		/>
	</section>
{/snippet}

<ChatsScreen {...props} {inbox} {attention} />
