/** Touch-only navigation gestures. An edge start and a decisive horizontal drag keep scrolling safe. */
export function drawerSwipe(shell: HTMLElement, drawer: HTMLDialogElement) {
	let start: { x: number; y: number; close: boolean; horizontal: boolean } | undefined;
	const reset = () => (start = undefined);
	const interactive = 'a, button, input, textarea, select, [contenteditable], [role="slider"]';
	function down(event: TouchEvent) {
		reset();
		if (event.touches.length !== 1) return;
		const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		if (shell.clientWidth >= 48 * rem) return;
		const target = event.target;
		if (!(target instanceof Element) || target.closest(interactive)) return;
		if (
			!drawer.open &&
			shell.querySelector(
				'[data-routed-sheet][data-state="open"], [role="dialog"][data-state="open"], dialog[open]'
			)
		)
			return;
		const touch = event.touches[0];
		const x = touch.clientX - shell.getBoundingClientRect().left;
		if (!drawer.open && (x < 8 || x > 48)) return;
		start = { x: touch.clientX, y: touch.clientY, close: drawer.open, horizontal: false };
	}
	function move(event: TouchEvent) {
		if (!start) return;
		if (event.touches.length !== 1) return reset();
		const touch = event.touches[0];
		const dx = (touch.clientX - start.x) * (start.close ? -1 : 1);
		const dy = Math.abs(touch.clientY - start.y);
		if (!start.horizontal) {
			if (dy > 12 || dx < -12) return reset();
			if (dx < 12 || dx < dy * 2) return;
			start.horizontal = true;
		}
		if (event.cancelable) event.preventDefault();
		if (dy > 48) reset();
	}
	function up(event: TouchEvent) {
		if (!start) return;
		const gesture = start;
		reset();
		const touch = event.changedTouches[0];
		if (!touch || !gesture.horizontal) return;
		const dx = (touch.clientX - gesture.x) * (gesture.close ? -1 : 1);
		const dy = Math.abs(touch.clientY - gesture.y);
		if (dx < 72 || dx < dy * 2) return;
		if (gesture.close) drawer.close();
		else drawer.showModal();
	}
	shell.addEventListener('touchstart', down, { passive: true });
	shell.addEventListener('touchmove', move, { passive: false });
	shell.addEventListener('touchend', up);
	shell.addEventListener('touchcancel', reset);
	return () => {
		shell.removeEventListener('touchstart', down);
		shell.removeEventListener('touchmove', move);
		shell.removeEventListener('touchend', up);
		shell.removeEventListener('touchcancel', reset);
	};
}
