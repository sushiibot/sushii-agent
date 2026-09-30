import type { Attachment } from 'svelte/attachments';

export const HOLD_MS = 500;
const SLOP_PX = 10;

/**
 * Opens a menu when a touch holds, or a right-click lands on, an element inside the node that
 * matches `selector`. Android Chrome fires `contextmenu` on a hold and the timer covers browsers
 * that don't; whichever comes first wins the gesture. Delegated from one listener so the list
 * re-rendering mid-hold (a streaming reply) never resets the timer.
 */
function scrollParent(el: HTMLElement): Element {
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
	}
	return document.scrollingElement ?? document.documentElement;
}

export function longPress(
	selector: string,
	onopen: (target: HTMLElement) => void
): Attachment<HTMLElement> {
	return (node) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let start: { x: number; y: number; id: number } | null = null;
		let fired = false;

		const find = (t: EventTarget | null) => {
			const el = t instanceof Element ? t.closest<HTMLElement>(selector) : null;
			return el && node.contains(el) ? el : null;
		};

		const open = (el: HTMLElement) => {
			if (fired) return;
			fired = true;
			try {
				navigator.vibrate?.(10);
			} catch {
				// Some browsers throw when vibration is blocked by policy.
			}
			onopen(el);
		};

		const cancel = () => {
			clearTimeout(timer);
			timer = undefined;
			start = null;
		};

		// A hold ends in pointerup, which may still click, possibly on the sheet's scrim that opened
		// under the finger: swallow it so it neither closes the sheet nor opens a held link. Often no
		// click comes at all, so the next gesture's pointerdown disarms the guard: that tap is the user's.
		const swallowClick = () => {
			const types = ['touchend', 'click'];
			const stop = (e: Event) => {
				e.preventDefault();
				e.stopPropagation();
				window.removeEventListener(e.type, stop, { capture: true });
			};
			const disarm = () => {
				clearTimeout(expiry);
				for (const type of types) window.removeEventListener(type, stop, { capture: true });
				window.removeEventListener('pointerdown', disarm, { capture: true });
			};
			// Cancelling touchend also drops the compat mousedown that would blur the sheet's focus.
			for (const type of types) {
				window.addEventListener(type, stop, { capture: true, passive: false });
			}
			window.addEventListener('pointerdown', disarm, { capture: true });
			const expiry = setTimeout(disarm, 400);
		};

		const onPointerDown = (e: PointerEvent) => {
			fired = false;
			cancel();
			if (e.pointerType === 'mouse' || !e.isPrimary) return;
			const el = find(e.target);
			if (!el) return;
			const scroller = scrollParent(el);
			const top = scroller.scrollTop;
			start = { x: e.clientX, y: e.clientY, id: e.pointerId };
			timer = setTimeout(() => {
				timer = undefined;
				// The list scrolled under a still finger (a fling): not a hold.
				const scrolled = Math.abs(scroller.scrollTop - top) > SLOP_PX;
				if (el.isConnected && !scrolled) open(el);
			}, HOLD_MS);
		};
		const onPointerMove = (e: PointerEvent) => {
			if (!start || e.pointerId !== start.id) return;
			if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) cancel();
		};
		const onPointerUp = () => {
			cancel();
			if (fired) swallowClick();
			fired = false;
		};
		const onContextMenu = (e: MouseEvent) => {
			const el = find(e.target);
			if (!el) return;
			// Let the browser's own menu act on text the reader selected with a mouse.
			const sel = document.getSelection();
			if (!fired && !start && sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
			e.preventDefault();
			cancel();
			open(el);
		};

		node.addEventListener('pointerdown', onPointerDown);
		node.addEventListener('pointermove', onPointerMove);
		node.addEventListener('pointerup', onPointerUp);
		node.addEventListener('pointercancel', cancel);
		node.addEventListener('contextmenu', onContextMenu);
		return () => {
			cancel();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('contextmenu', onContextMenu);
		};
	};
}
