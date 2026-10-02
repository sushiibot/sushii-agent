import { afterEach, expect, test } from 'bun:test';
import { swipeTabs, tabSwipeTarget } from './swipe';

const sections = ['recaps', 'runs', 'memory'];

test('horizontal gestures move one visible section in the expected direction', () => {
	expect(tabSwipeTarget(sections, 'recaps', -72, 0)).toBe('runs');
	expect(tabSwipeTarget(sections, 'runs', -240, 20)).toBe('memory');
	expect(tabSwipeTarget(sections, 'runs', 120, -20)).toBe('recaps');
});

test('first and last sections never wrap; missing or empty sections do nothing', () => {
	expect(tabSwipeTarget(sections, 'recaps', 120, 0)).toBeUndefined();
	expect(tabSwipeTarget(sections, 'memory', -120, 0)).toBeUndefined();
	expect(tabSwipeTarget(sections, 'removed', -120, 0)).toBeUndefined();
	expect(tabSwipeTarget([], 'recaps', -120, 0)).toBeUndefined();
	expect(tabSwipeTarget(['only'], 'only', -120, 0)).toBeUndefined();
});

test('short, diagonal and vertical gestures cannot change a section', () => {
	for (const [dx, dy] of [
		[71, 0],
		[-71, 0],
		[0, 120],
		[-80, 45],
		[120, 49],
		[120, -49]
	]) {
		expect(tabSwipeTarget(sections, 'runs', dx, dy)).toBeUndefined();
	}
	expect(tabSwipeTarget(sections, 'runs', -96, 48)).toBe('memory');
});

// Minimal event/DOM adapter: real EventTarget cancellation exercises the action without a browser.
class TestElement extends EventTarget {
	parentElement: TestElement | null = null;
	clientWidth = 100;
	scrollWidth = 100;
	style = { overflowX: 'visible', fontSize: '16px' };
	interactive = false;
	ownerDocument!: Document;
	closest() {
		return this.interactive ? this : null;
	}
}

const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
afterEach(() => {
	if (originalElement) Object.defineProperty(globalThis, 'Element', originalElement);
	else Reflect.deleteProperty(globalThis, 'Element');
});

function harness(value = 'runs', enabled = true) {
	Object.defineProperty(globalThis, 'Element', { configurable: true, value: TestElement });
	let time = 0;
	const environment = { width: 412, overlay: false, selection: false };
	const node = new TestElement();
	const row = new TestElement();
	row.parentElement = node;
	node.ownerDocument = {
		documentElement: node,
		querySelector: () => (environment.overlay ? row : null),
		getSelection: () => ({ isCollapsed: !environment.selection }),
		defaultView: {
			get innerWidth() {
				return environment.width;
			},
			performance: { now: () => time },
			getComputedStyle: (element: TestElement) => element.style
		}
	} as unknown as Document;
	const changes: string[] = [];
	const getter = () => ({
		values: sections,
		value,
		onchange: (next: string) => {
			changes.push(next);
			value = next;
		}
	});
	const action = swipeTabs(node as unknown as HTMLElement, enabled ? getter : undefined);
	function touch(type: string, x: number, y = 100, count = 1) {
		const point = { identifier: 0, clientX: x, clientY: y };
		const event = new Event(type, { cancelable: true });
		Object.defineProperties(event, {
			target: { value: row },
			touches: { value: type === 'touchend' ? [] : Array.from({ length: count }, () => point) },
			changedTouches: { value: [point] }
		});
		node.dispatchEvent(event);
		return event;
	}
	function click(x: number, detail = 1) {
		const event = new Event('click', { cancelable: true });
		Object.defineProperties(event, {
			clientX: { value: x },
			clientY: { value: 100 },
			detail: { value: detail }
		});
		node.dispatchEvent(event);
		return event;
	}
	const swipe = () => {
		touch('touchstart', 220);
		touch('touchmove', 180);
		return touch('touchend', 120);
	};
	return {
		environment,
		row,
		action,
		touch,
		click,
		changes,
		swipe,
		getter,
		advance: (ms: number) => {
			time += ms;
		}
	};
}

test('linked rows keep taps and keyboard clicks, but a completed swipe suppresses its click', () => {
	const h = harness();
	h.touch('touchstart', 220);
	h.touch('touchend', 220);
	expect(h.click(220).defaultPrevented).toBe(false);
	expect(h.swipe().defaultPrevented).toBe(true);
	expect(h.changes).toEqual(['memory']);
	expect(h.click(120, 0).defaultPrevented).toBe(false);
	expect(h.click(120).defaultPrevented).toBe(true);
	expect(h.click(120).defaultPrevented).toBe(false);
});

test('outward center drags keep the section and block browser navigation; vertical scrolling remains free', () => {
	const boundary = harness('memory');
	boundary.touch('touchstart', 220);
	expect(boundary.touch('touchmove', 180).defaultPrevented).toBe(true);
	expect(boundary.touch('touchend', 120).defaultPrevented).toBe(true);
	expect(boundary.changes).toEqual([]);
	const vertical = harness();
	vertical.touch('touchstart', 220);
	expect(vertical.touch('touchmove', 210, 140).defaultPrevented).toBe(false);
	vertical.touch('touchend', 120, 140);
	expect(vertical.changes).toEqual([]);
});

test('reserved edges, desktop, interactive controls, scrollers and overlays ignore swipes', () => {
	for (const x of [48, 388]) {
		const h = harness();
		h.touch('touchstart', x);
		h.touch('touchmove', x - 40);
		h.touch('touchend', x - 100);
		expect(h.changes).toEqual([]);
	}
	for (const setup of [
		(h: ReturnType<typeof harness>) => {
			h.environment.width = 768;
		},
		(h: ReturnType<typeof harness>) => {
			h.environment.overlay = true;
		},
		(h: ReturnType<typeof harness>) => {
			h.environment.selection = true;
		},
		(h: ReturnType<typeof harness>) => {
			h.row.interactive = true;
		},
		(h: ReturnType<typeof harness>) => {
			h.row.style.overflowX = 'auto';
			h.row.scrollWidth = 300;
		}
	]) {
		const h = harness();
		setup(h);
		h.swipe();
		expect(h.changes).toEqual([]);
	}
});

test('multitouch, long holds, cancellation and optional action updates cancel pending gestures', () => {
	for (const cancel of [
		(h: ReturnType<typeof harness>) => {
			h.touch('touchmove', 180, 100, 2);
		},
		(h: ReturnType<typeof harness>) => {
			h.advance(901);
		},
		(h: ReturnType<typeof harness>) => {
			h.touch('touchcancel', 180);
		},
		(h: ReturnType<typeof harness>) => {
			h.action.update(undefined);
		}
	]) {
		const h = harness();
		h.touch('touchstart', 220);
		h.touch('touchmove', 180);
		cancel(h);
		h.touch('touchend', 120);
		expect(h.changes).toEqual([]);
	}
	const h = harness('runs', false);
	h.swipe();
	expect(h.changes).toEqual([]);
	h.action.update(h.getter);
	h.swipe();
	expect(h.changes).toEqual(['memory']);
	h.action.destroy();
	h.swipe();
	expect(h.changes).toEqual(['memory']);
});
