<script lang="ts">
	import type { Snippet } from 'svelte';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { Button } from '$lib/ui/button';

	let { label, children }: { label: string; children: Snippet<[close: () => void]> } = $props();
	const uid = $props.id();
	let content: HTMLDivElement;
	let open = $state(false);
	function close() {
		content?.hidePopover();
	}
	function items() {
		return Array.from(content.querySelectorAll<HTMLElement>('button:not(:disabled), a'));
	}
	function toggle(event: ToggleEvent) {
		open = event.newState === 'open';
		if (open) items()[0]?.focus({ preventScroll: true });
	}
	function keydown(event: KeyboardEvent) {
		if (!open || !content.contains(document.activeElement)) return;
		const options = items();
		const current = options.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === 'ArrowDown'
				? (current + 1) % options.length
				: event.key === 'ArrowUp'
					? (current - 1 + options.length) % options.length
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? options.length - 1
							: -1;
		if (next >= 0) {
			event.preventDefault();
			options[next]?.focus({ preventScroll: true });
		}
	}
</script>

<svelte:window onkeydown={keydown} />
<Button
	variant="ghost"
	class="size-12 px-0"
	aria-label={label}
	aria-expanded={open}
	aria-controls={uid}
	popovertarget={uid}
>
	<EllipsisVertical class="size-5" />
</Button>
<div
	id={uid}
	bind:this={content}
	popover="auto"
	ontoggle={toggle}
	role="group"
	aria-label={label}
	class="fixed top-[calc(var(--safe-top)+3.5rem)] right-4 bottom-auto left-auto m-0 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg [&:not(:popover-open)]:hidden"
>
	{@render children(close)}
</div>
