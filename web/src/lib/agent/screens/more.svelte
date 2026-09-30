<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import AppShell, { moreItems } from '../app-shell.svelte';

	let { notifications = false }: { notifications?: boolean } = $props();
	const uid = $props.id();
	const notes: Record<string, string> = {
		runs: 'Every run, with its evidence',
		memory: 'What the agent remembers and has learned',
		schedules: 'Jobs, briefings and checks',
		connectors: 'Mail, calendar and MCP servers',
		history: 'Search past chats and runs'
	};
</script>

<AppShell active="more" title="More" waiting={2} unread>
	<div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-4">
		<ul class="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
			{#each moreItems as item (item.id)}
				<li>
					<a href={item.href} class="flex items-center gap-3 px-3 py-3 hover:bg-muted/60">
						<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
							<item.icon class="size-[18px]" aria-hidden="true" />
						</span>
						<span class="flex min-w-0 flex-col">
							<span class="text-[15px] font-medium">{item.label}</span>
							<span class="truncate text-sm text-muted-foreground">{notes[item.id]}</span>
						</span>
						<ChevronRight
							class="ml-auto size-4 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					</a>
				</li>
			{/each}
		</ul>

		<section aria-labelledby="{uid}-app" class="flex flex-col gap-1">
			<h2 id="{uid}-app" class="px-1 pb-1 text-sm font-semibold text-muted-foreground">
				This device
			</h2>
			<div class="flex items-center gap-3 rounded-xl border bg-card px-3 py-3">
				<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
					<BellRing class="size-[18px]" aria-hidden="true" />
				</span>
				<span class="flex min-w-0 flex-col">
					<span class="text-[15px] font-medium">Notifications</span>
					<span class="text-sm text-muted-foreground"
						>{notifications ? 'On: approvals, questions, failures' : 'Off'}</span
					>
				</span>
			</div>
		</section>
	</div>
</AppShell>
