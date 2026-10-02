<script lang="ts" module>
	export interface SwipeableTab {
		value: string;
		label: string;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import emblaCarouselSvelte from 'embla-carousel-svelte';
	import type { EmblaCarouselType } from 'embla-carousel';
	import { cn } from '$lib/utils';

	let {
		tabs,
		value = $bindable(''),
		label,
		onchange,
		lead,
		class: className,
		children
	}: {
		tabs: readonly SwipeableTab[];
		value?: string;
		label: string;
		onchange?: (value: string) => void;
		lead?: Snippet;
		class?: string;
		children: Snippet<[value: string]>;
	} = $props();

	const uid = $props.id();
	let api = $state.raw<EmblaCarouselType>();
	let tablist: HTMLDivElement;
	let indicator: HTMLSpanElement;
	let reducedMotion = false;
	let rtl = false;
	let dragging = false;
	let tabGeometry: { left: number; width: number }[] = [];
	const active = $derived(tabs.findIndex((tab) => tab.value === value));
	const controls =
		'button, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [role="combobox"], [draggable="true"]';
	const overlays =
		'dialog[open], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

	function choose(next: string, notify = true) {
		if (next === value) return;
		value = next;
		if (notify) onchange?.(next);
	}

	function select(carousel: EmblaCarouselType) {
		const tab = tabs[carousel.selectedScrollSnap()];
		if (tab) choose(tab.value, dragging);
	}

	function measure() {
		if (!tablist) return;
		tabGeometry = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')).map(
			(button) => ({ left: button.offsetLeft, width: button.offsetWidth })
		);
		paintIndicator();
	}

	function paintIndicator() {
		if (!indicator || !tabGeometry.length) return;
		const position = Math.max(
			0,
			Math.min(tabs.length - 1, (api?.scrollProgress() ?? 0) * (tabs.length - 1))
		);
		const low = Math.floor(position);
		const high = Math.min(low + 1, tabGeometry.length - 1);
		const fraction = position - low;
		const from = tabGeometry[low];
		const to = tabGeometry[high];
		if (!from || !to) return;
		indicator.style.transform = `translateX(${from.left + (to.left - from.left) * fraction}px)`;
		indicator.style.width = `${from.width + (to.width - from.width) * fraction}px`;
	}

	function activate(index: number) {
		const tab = tabs[index];
		if (!tab) return;
		choose(tab.value);
		api?.scrollTo(index, reducedMotion);
	}

	function keydown(event: KeyboardEvent, index: number) {
		let next: number;
		if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = tabs.length - 1;
		else if (event.key === 'ArrowRight')
			next = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length;
		else if (event.key === 'ArrowLeft') next = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length;
		else return;
		event.preventDefault();
		activate(next);
		tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
	}

	function allowDrag(carousel: EmblaCarouselType, event: MouseEvent | TouchEvent) {
		if (event.type !== 'touchstart') return false;
		const touchEvent = event as TouchEvent;
		const viewport = carousel.rootNode();
		const doc = viewport.ownerDocument;
		const view = doc.defaultView!;
		const rem = parseFloat(view.getComputedStyle(doc.documentElement).fontSize) || 16;
		if (
			touchEvent.touches.length !== 1 ||
			view.innerWidth >= 48 * rem ||
			doc.querySelector(overlays) ||
			doc.getSelection()?.isCollapsed === false
		)
			return false;
		const x = touchEvent.touches[0].clientX;
		if (x <= 48 || x >= view.innerWidth - 24) return false;
		const target = event.target;
		if (!(target instanceof Element) || target.closest(controls)) return false;
		for (
			let element: Element | null = target;
			element && element !== viewport;
			element = element.parentElement
		) {
			const style = view.getComputedStyle(element);
			if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
				return false;
		}
		return true;
	}

	function carousel(viewport: HTMLElement) {
		const view = viewport.ownerDocument.defaultView!;
		const media = view.matchMedia('(prefers-reduced-motion: reduce)');
		const motionChange = () => {
			reducedMotion = media.matches;
			if (reducedMotion && api) api.scrollTo(api.selectedScrollSnap(), true);
		};
		motionChange();
		media.addEventListener('change', motionChange);
		rtl = view.getComputedStyle(viewport).direction === 'rtl';
		const pointerDown = () => {
			dragging = true;
		};
		const pointerUp = (carousel: EmblaCarouselType) => {
			dragging = false;
			if (reducedMotion) carousel.scrollTo(carousel.selectedScrollSnap(), true);
		};
		const cancelSelectionDrag = () => {
			if (
				dragging &&
				(viewport.ownerDocument.getSelection()?.isCollapsed === false ||
					viewport.ownerDocument.querySelector(overlays))
			)
				viewport.dispatchEvent(new Event('touchcancel'));
		};
		viewport.addEventListener('touchmove', cancelSelectionDrag, { capture: true, passive: true });
		const init = (event: Event) => {
			api = (event as CustomEvent<EmblaCarouselType>).detail;
			api
				.on('select', select)
				.on('scroll', paintIndicator)
				.on('settle', paintIndicator)
				.on('reInit', measure)
				.on('pointerDown', pointerDown)
				.on('pointerUp', pointerUp);
			measure();
		};
		viewport.addEventListener('emblaInit', init);
		const action = emblaCarouselSvelte(viewport, {
			options: {
				align: 'start',
				loop: false,
				dragFree: false,
				skipSnaps: false,
				duration: 20,
				containScroll: false,
				startIndex: Math.max(0, active),
				direction: rtl ? 'rtl' : 'ltr',
				watchDrag: allowDrag,
				watchFocus: false
			},
			plugins: []
		});
		const resize = new ResizeObserver(measure);
		resize.observe(tablist);
		resize.observe(viewport);
		return {
			destroy() {
				resize.disconnect();
				media.removeEventListener('change', motionChange);
				viewport.removeEventListener('touchmove', cancelSelectionDrag, true);
				viewport.removeEventListener('emblaInit', init);
				action.destroy?.();
			}
		};
	}

	$effect(() => {
		const index = active;
		if (api && index >= 0 && api.selectedScrollSnap() !== index) api.scrollTo(index, reducedMotion);
	});
	$effect(() => {
		tabs;
		value;
		void tick().then(() => {
			measure();
			tablist
				?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
				?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
		});
	});
</script>

<div class={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
	<div class="min-w-0 shrink-0 bg-background">
		{@render lead?.()}
		<div class="min-w-0 overflow-x-auto overscroll-contain border-b">
			<div
				bind:this={tablist}
				role="tablist"
				aria-label={label}
				aria-orientation="horizontal"
				class="relative mx-auto flex w-full max-w-2xl min-w-0 gap-1 px-2"
			>
				{#each tabs as tab, index (tab.value)}
					<button
						id="{uid}-tab-{encodeURIComponent(tab.value)}"
						role="tab"
						type="button"
						aria-selected={value === tab.value}
						aria-controls="{uid}-panel-{encodeURIComponent(tab.value)}"
						tabindex={value === tab.value ? 0 : -1}
						onclick={() => activate(index)}
						onkeydown={(event) => keydown(event, index)}
						class={cn(
							'min-h-12 min-w-12 flex-1 truncate px-1 text-sm font-medium text-muted-foreground hover:text-foreground',
							value === tab.value && 'text-foreground'
						)}>{tab.label}</button
					>
				{/each}
				<span
					bind:this={indicator}
					data-tab-indicator
					class="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-foreground"
					aria-hidden="true"
				></span>
			</div>
		</div>
	</div>
	<div
		use:carousel
		data-tab-pager
		class="min-h-0 flex-1 overflow-hidden"
		style="touch-action: auto;"
	>
		<div data-tab-track class="flex h-full">
			{#each tabs as tab, index (tab.value)}
				<div
					id="{uid}-panel-{encodeURIComponent(tab.value)}"
					role="tabpanel"
					aria-labelledby="{uid}-tab-{encodeURIComponent(tab.value)}"
					aria-hidden={value !== tab.value}
					inert={value !== tab.value}
					tabindex={value === tab.value ? 0 : -1}
					data-tab-panel={tab.value}
					class="h-full min-w-0 flex-[0_0_100%] overflow-x-hidden overflow-y-auto overscroll-contain"
				>
					{@render children(tab.value)}
				</div>
			{/each}
		</div>
	</div>
</div>
