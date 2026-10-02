export interface SwipeTabsOptions {
	/** Visible sections in their on-screen order. Left swipes advance; right swipes go back. */
	values: readonly string[];
	value: string;
	onchange: (value: string) => void;
}

function deliberateSwipe(dx: number, dy: number) {
	return Math.abs(dx) >= 72 && Math.abs(dy) <= 48 && Math.abs(dx) >= Math.abs(dy) * 2;
}

/** Return an adjacent section only for a deliberate horizontal gesture; never wrap. */
export function tabSwipeTarget(values: readonly string[], value: string, dx: number, dy: number) {
	if (!deliberateSwipe(dx, dy)) return undefined;
	const index = values.indexOf(value);
	if (index < 0) return undefined;
	return values[index + (dx < 0 ? 1 : -1)];
}

const interactive =
	'button, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [role="combobox"], [draggable="true"]';
const overlays =
	'dialog[open], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Touch-only section navigation below 48rem. Apply to the content wrapper, keeping visible tabs
 * as the keyboard/tap alternative. A getter keeps controlled section state current:
 * use:swipeTabs={() => ({ values, value, onchange: next => { value = next; } })}
 *
 * Leaves edge navigation, controls, horizontal scrollers, overlays and vertical scrolling alone.
 */
export function swipeTabs(node: HTMLElement, getOptions?: () => SwipeTabsOptions) {
	let options = getOptions;
	let start:
		| { id: number; x: number; y: number; at: number; value: string; horizontal: boolean }
		| undefined;
	let suppressedClick: { x: number; y: number; until: number } | undefined;
	const reset = () => (start = undefined);
	const doc = node.ownerDocument;
	const view = doc.defaultView!;
	const now = () => view.performance.now();
	const overlayOpen = () => doc.querySelector(overlays) !== null;

	function horizontalScroller(target: Element) {
		for (
			let element: Element | null = target;
			element && element !== node;
			element = element.parentElement
		) {
			const style = view.getComputedStyle(element);
			if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
				return true;
		}
		return false;
	}

	function down(event: TouchEvent) {
		reset();
		suppressedClick = undefined;
		if (!options || event.touches.length !== 1 || overlayOpen()) return;
		const rem = parseFloat(view.getComputedStyle(doc.documentElement).fontSize) || 16;
		if (view.innerWidth >= 48 * rem) return;
		const target = event.target;
		if (!(target instanceof Element) || target.closest(interactive) || horizontalScroller(target))
			return;
		if (doc.getSelection()?.isCollapsed === false) return;
		const touch = event.touches[0];
		// The drawer owns the left edge; the OS/browser owns the right edge.
		if (touch.clientX <= 48 || touch.clientX >= view.innerWidth - 24) return;
		const { values, value } = options();
		if (values.length < 2 || !values.includes(value)) return;
		start = {
			id: touch.identifier,
			x: touch.clientX,
			y: touch.clientY,
			at: now(),
			value,
			horizontal: false
		};
	}

	function move(event: TouchEvent) {
		if (!start || !options) return;
		if (
			event.touches.length !== 1 ||
			overlayOpen() ||
			doc.getSelection()?.isCollapsed === false ||
			now() - start.at > 900
		)
			return reset();
		const touch = event.touches[0];
		if (touch.identifier !== start.id) return reset();
		const dx = touch.clientX - start.x;
		const dy = Math.abs(touch.clientY - start.y);
		const { value } = options();
		if (value !== start.value) return reset();
		if (!start.horizontal) {
			if (dy > 12) return reset();
			if (Math.abs(dx) < 16 || Math.abs(dx) < dy * 2) return;
			start.horizontal = true;
		}
		// Claim intentional center drags even at a boundary so they cannot trigger browser Back.
		if (dy > 48) return reset();
		if (event.cancelable) event.preventDefault();
	}

	function up(event: TouchEvent) {
		if (!start || !options) return;
		const gesture = start;
		reset();
		if (
			!gesture.horizontal ||
			event.touches.length !== 0 ||
			overlayOpen() ||
			doc.getSelection()?.isCollapsed === false ||
			now() - gesture.at > 900
		)
			return;
		const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === gesture.id);
		if (!touch) return;
		const { values, value, onchange } = options();
		if (value !== gesture.value) return;
		const dx = touch.clientX - gesture.x;
		const dy = touch.clientY - gesture.y;
		if (!deliberateSwipe(dx, dy)) return;
		const next = tabSwipeTarget(values, value, dx, dy);
		if (event.cancelable) event.preventDefault();
		suppressedClick = { x: touch.clientX, y: touch.clientY, until: now() + 500 };
		if (next !== undefined) onchange(next);
	}

	function click(event: MouseEvent) {
		if (
			suppressedClick &&
			event.detail > 0 &&
			now() < suppressedClick.until &&
			Math.abs(event.clientX - suppressedClick.x) < 32 &&
			Math.abs(event.clientY - suppressedClick.y) < 32
		) {
			suppressedClick = undefined;
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}

	node.addEventListener('touchstart', down, { passive: true });
	node.addEventListener('touchmove', move, { passive: false });
	node.addEventListener('touchend', up, { passive: false });
	node.addEventListener('touchcancel', reset);
	node.addEventListener('click', click, true);
	return {
		update(next?: () => SwipeTabsOptions) {
			options = next;
			reset();
		},
		destroy() {
			node.removeEventListener('touchstart', down);
			node.removeEventListener('touchmove', move);
			node.removeEventListener('touchend', up);
			node.removeEventListener('touchcancel', reset);
			node.removeEventListener('click', click, true);
		}
	};
}
