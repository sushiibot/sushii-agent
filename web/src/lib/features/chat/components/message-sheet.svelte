<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Share2 from '@lucide/svelte/icons/share-2';
	import TextSelect from '@lucide/svelte/icons/text-select';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from '../types';

	// Read-only actions on one message. Decisions (approve, allow, run) live only in the approval
	// tray, so nothing here may ever act on an approval.
	let {
		message,
		preview,
		canShare = false,
		oncopy,
		onshare,
		onselect,
		onretry,
		ondelete
	}: {
		message: ChatMessage;
		preview: string;
		canShare?: boolean;
		oncopy?: () => void;
		onshare?: () => void;
		onselect?: () => void;
		onretry?: () => void;
		ondelete?: () => void;
	} = $props();

	const unsent = $derived(
		message.role === 'user' &&
			!message.unverified &&
			(message.delivery === 'failed' ||
				message.delivery === 'queued' ||
				message.delivery === 'queued-agent')
	);

	const actions = $derived(
		[
			{ id: 'copy', icon: Copy, label: 'Copy text', run: oncopy, tone: '' },
			canShare && { id: 'share', icon: Share2, label: 'Share', run: onshare, tone: '' },
			{ id: 'select', icon: TextSelect, label: 'Select text', run: onselect, tone: '' },
			unsent && { id: 'retry', icon: RotateCcw, label: 'Retry send', run: onretry, tone: '' },
			unsent && {
				id: 'delete',
				icon: Trash2,
				label: 'Delete message',
				run: ondelete,
				tone: 'text-failed'
			}
		].filter((a) => !!a)
	);
</script>

<div class="flex flex-col gap-2 px-3 pt-1 pb-3">
	<h2 class="sr-only">Message actions</h2>
	<p
		class="mx-2 line-clamp-2 border-l-2 pl-3 text-sm [overflow-wrap:anywhere] text-muted-foreground"
	>
		{preview}
	</p>
	<ul class="flex flex-col">
		{#each actions as a, i (a.id)}
			<li>
				<button
					type="button"
					data-autofocus={i === 0 ? '' : undefined}
					onclick={a.run}
					class={cn(
						'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-body font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
						a.tone
					)}
				>
					<a.icon
						class={cn('size-5 shrink-0', a.tone || 'text-muted-foreground')}
						aria-hidden="true"
					/>
					{a.label}
				</button>
			</li>
		{/each}
	</ul>
</div>
