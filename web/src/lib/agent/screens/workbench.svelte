<script lang="ts">
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import AppShell from '../app-shell.svelte';
	import Conversation from '../conversation.svelte';
	import SessionIcon from '../session-icon.svelte';
	import type { ChatMessage, Session } from '../types';

	let { panes }: { panes: { session: Session; messages: ChatMessage[] }[] } = $props();
	const uid = $props.id();
</script>

<AppShell active="chats" title="Chats" waiting={2} unread>
	<div class="grid h-full grid-cols-2 divide-x">
		{#each panes as pane, i (pane.session.id)}
			<section aria-labelledby="{uid}-{i}" class="flex min-h-0 flex-col">
				<header class="flex items-center gap-2.5 border-b px-4 py-2">
					<SessionIcon kind={pane.session.kind} class="size-7" />
					<div class="flex min-w-0 flex-col">
						<h2 id="{uid}-{i}" class="truncate text-sm font-semibold">{pane.session.title}</h2>
						{#if pane.session.kind === 'thread'}
							<span class="inline-flex items-center gap-1 text-xs text-muted-foreground"
								><BookMarked class="size-3" aria-hidden="true" />Shares memory with Main</span
							>
						{/if}
					</div>
					{#if i > 0}
						<Button variant="ghost" size="icon-sm" class="ml-auto" aria-label="Close pane"
							><X /></Button
						>
					{/if}
				</header>
				<div class="min-h-0 flex-1 overflow-y-auto">
					<Conversation messages={pane.messages} />
				</div>
				<form class="border-t p-3" onsubmit={(e) => e.preventDefault()}>
					<label for="{uid}-c-{i}" class="sr-only">Message {pane.session.title}</label>
					<div
						class="flex items-end gap-2 rounded-3xl border bg-card p-1 pl-2 focus-within:ring-2 focus-within:ring-ring/40"
					>
						<Textarea
							id="{uid}-c-{i}"
							rows={1}
							placeholder="Message {pane.session.title}"
							class="min-h-9 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
						/>
						<Button
							size="icon-lg"
							type="submit"
							class="rounded-full"
							aria-label="Send to {pane.session.title}"><ArrowUp /></Button
						>
					</div>
				</form>
			</section>
		{/each}
	</div>
</AppShell>
