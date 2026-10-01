<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Dialog as SheetPrimitive } from 'bits-ui';
	import * as Sheet from '$lib/ui/sheet';
	import { cn } from '$lib/utils';

	let {
		open,
		label,
		onclose,
		desktop = true,
		children
	}: {
		open: boolean;
		label: string;
		/** Escape, a tap on the scrim, or a close inside; the caller owns the history entry. */
		onclose?: () => void;
		/** Show at desktop widths too, as a centred dialog. Off only for a sheet whose content has
		 *  a desktop home of its own; such a sheet closes itself there. */
		desktop?: boolean;
		children: Snippet;
	} = $props();

	let content = $state<HTMLElement | null>(null);
	let probe = $state<HTMLElement | null>(null);
	let wide = $state(false);
	const shown = $derived(open && (desktop || !wide));
	// A sheet that can't show must not keep its history entry, or Back is spent on nothing.
	$effect(() => {
		if (open && !shown) onclose?.();
	});

	// Desktop is the shell's width, not the window's, so a phone frame on the prototype board
	// still gets phone sheets. Matches the shell's @3xl breakpoint.
	$effect(() => {
		const box = probe?.closest<HTMLElement>('[data-shell]') ?? document.documentElement;
		const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		const ro = new ResizeObserver(() => (wide = box.clientWidth >= 48 * rem));
		ro.observe(box);
		return () => ro.disconnect();
	});

	function focusFirst(e: Event) {
		e.preventDefault();
		const target = content?.querySelector<HTMLElement>('[data-autofocus]') ?? content;
		target?.focus({ preventScroll: true });
	}
</script>

<span bind:this={probe} hidden></span>
<Sheet.Root
	open={shown}
	onOpenChange={(next) => {
		if (!next) onclose?.();
	}}
>
	<Sheet.Portal>
		<Sheet.Overlay class="z-20 bg-scrim supports-backdrop-filter:backdrop-blur-none" />
		<SheetPrimitive.Content
			bind:ref={content}
			aria-label={label}
			onOpenAutoFocus={focusFirst}
			class={cn(
				'fixed inset-x-0 bottom-(--kb) z-20 flex max-h-[88%] flex-col overflow-y-auto overscroll-contain rounded-t-3xl bg-background pb-(--safe-bottom) text-foreground shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.4)] outline-none kb:pb-0',
				'duration-(--duration-medium) ease-(--ease-standard) motion-reduce:animate-none data-open:animate-in data-open:slide-in-from-bottom-10 data-closed:animate-out data-closed:slide-out-to-bottom-10',
				desktop &&
					'@3xl:inset-x-auto @3xl:top-1/2 @3xl:bottom-auto @3xl:left-1/2 @3xl:w-full @3xl:max-w-md @3xl:-translate-x-1/2 @3xl:-translate-y-1/2 @3xl:rounded-3xl @3xl:pb-0'
			)}
		>
			<span
				class={cn(
					'mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/35',
					desktop && '@3xl:invisible'
				)}
			></span>
			{@render children()}
		</SheetPrimitive.Content>
	</Sheet.Portal>
</Sheet.Root>
