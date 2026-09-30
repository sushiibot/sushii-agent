<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import Moon from '@lucide/svelte/icons/moon';
	import Send from '@lucide/svelte/icons/send';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import AppShell, { moreItems } from '../app-shell.svelte';
	import type { PushState } from '../types';

	let {
		push = 'default',
		quietHours = false,
		testSent = false
	}: { push?: PushState; quietHours?: boolean; testSent?: boolean } = $props();
	// svelte-ignore state_referenced_locally
	let quiet = $state(quietHours);
	const pushLine: Record<PushState, string> = {
		granted: 'On. Approvals, questions, failures, and replies that finish while you are away.',
		default: 'Off. Approvals can wait unseen.',
		denied: 'Blocked in Android settings for this app.',
		unsupported: "This browser can't show notifications."
	};
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
			<div class="flex flex-col divide-y rounded-xl border bg-card">
				<div class="flex items-start gap-3 px-3 py-3">
					<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
						<BellRing class="size-[18px]" aria-hidden="true" />
					</span>
					<span class="flex min-w-0 flex-1 flex-col gap-2">
						<span class="flex flex-col">
							<span class="text-[15px] font-medium">Notify when away</span>
							<span class="text-sm text-muted-foreground">{pushLine[push]}</span>
						</span>
						{#if push === 'granted'}
							<Button variant="outline" class="self-start"><Send />Send test notification</Button>
							{#if testSent}
								<span role="status" class="text-sm text-muted-foreground"
									>Test sent. It should arrive in a few seconds.</span
								>
							{/if}
						{:else if push === 'default'}
							<Button class="self-start">Enable notifications</Button>
						{/if}
					</span>
				</div>
				<label class="flex items-center gap-3 px-3 py-3">
					<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
						<Moon class="size-[18px]" aria-hidden="true" />
					</span>
					<span class="flex min-w-0 flex-1 flex-col">
						<span class="text-[15px] font-medium">Quiet hours, 22:00–07:00</span>
						<span class="text-sm text-muted-foreground"
							>During quiet hours only approvals and questions ring.</span
						>
					</span>
					<Switch bind:checked={quiet} disabled={push !== 'granted'} />
				</label>
			</div>
		</section>
	</div>
</AppShell>
